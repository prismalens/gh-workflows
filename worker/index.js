let cachedCerts = null;
let certsExpiry = 0;

function serializeJson(val, fallback) {
  if (val === undefined || val === null) {
    return fallback;
  }
  return typeof val === "string" ? val : JSON.stringify(val);
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let acc = 0;
  for (let i = 0; i < aBytes.length; i++) {
    acc |= aBytes[i] ^ bBytes[i];
  }
  return acc === 0;
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseJwtPart(part) {
  const bytes = base64UrlDecode(part);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

async function getSigningKeys(teamDomain) {
  const now = Date.now();
  if (cachedCerts && now < certsExpiry) {
    return cachedCerts;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) {
    throw new Error("Failed to fetch certs");
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.keys)) {
    throw new Error("Invalid certs payload");
  }
  cachedCerts = data.keys;
  certsExpiry = now + 3600 * 1000;
  return cachedCerts;
}

// Origin requests bypass Access; validate JWT directly to keep read routes closed (#46).
async function verifyAccess(request, env) {
  const teamDomain = env?.ACCESS_TEAM_DOMAIN;
  const expectedAud = env?.ACCESS_AUD;
  if (!teamDomain || !expectedAud) {
    return new Response(JSON.stringify({ error: "read API not configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  let header, payload;
  try {
    header = parseJwtPart(parts[0]);
    payload = parseJwtPart(parts[1]);
  } catch {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  if (header?.alg !== "RS256" || !header?.kid) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  let keys;
  try {
    keys = await getSigningKeys(teamDomain);
  } catch {
    return new Response(JSON.stringify({ error: "failed to fetch signing keys" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const matchingKey = keys.find((k) => k.kid === header.kid);
  if (!matchingKey) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      matchingKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signature = base64UrlDecode(parts[2]);
    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const isValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signedData
    );
    if (!isValid) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const aud = payload?.aud;
  const hasAud = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (!hasAud) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload?.exp !== "number" || payload.exp <= now) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  if (payload?.iss !== `https://${teamDomain}`) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  return null;
}

async function handleSummary(env) {
  const stats = await env.DB.prepare(
    `SELECT
      COUNT(*) as rows,
      AVG(duration_ms) as mean_duration,
      AVG(permission_denials) as denials_per_run,
      SUM(input_tokens) as sum_input,
      SUM(cache_read_input_tokens) as sum_read,
      SUM(cache_creation_input_tokens) as sum_create,
      SUM(total_cost_usd) as total_cost_usd,
      MIN(recorded_at) as first_recorded_at,
      MAX(recorded_at) as last_recorded_at
    FROM usage_records`
  ).first();

  if (!stats || stats.rows === 0) {
    return new Response(
      JSON.stringify({
        rows: 0,
        repositories: [],
        wall_clock_ms: { mean: null, p95: null },
        denials_per_run: null,
        cache_hit_rate: null,
        caching_multiplier: null,
        total_cost_usd: null,
        first_recorded_at: null,
        last_recorded_at: null,
      }),
      { headers: { "content-type": "application/json" } }
    );
  }

  const repoRows = await env.DB.prepare(
    "SELECT DISTINCT repository FROM usage_records ORDER BY repository"
  ).all();
  const repositories = repoRows.results ? repoRows.results.map((r) => r.repository) : [];

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM usage_records WHERE duration_ms IS NOT NULL"
  ).first();
  let p95 = null;
  if (countRow && countRow.cnt > 0) {
    const offset = Math.min(Math.floor(countRow.cnt * 0.95), countRow.cnt - 1);
    const p95Row = await env.DB.prepare(
      "SELECT duration_ms FROM usage_records WHERE duration_ms IS NOT NULL ORDER BY duration_ms ASC LIMIT 1 OFFSET ?"
    ).bind(offset).first();
    p95 = p95Row ? p95Row.duration_ms : null;
  }

  let cache_hit_rate = null;
  let caching_multiplier = null;
  if (stats.sum_input !== null || stats.sum_read !== null || stats.sum_create !== null) {
    const input = stats.sum_input ?? 0;
    const read = stats.sum_read ?? 0;
    const create = stats.sum_create ?? 0;
    const totalTokens = input + read + create;
    if (totalTokens > 0) {
      cache_hit_rate = read / totalTokens;
      const weighted = input + 1.25 * create + 0.1 * read;
      caching_multiplier = weighted > 0 ? totalTokens / weighted : null;
    }
  }

  return new Response(
    JSON.stringify({
      rows: stats.rows,
      repositories,
      wall_clock_ms: {
        mean: stats.mean_duration,
        p95,
      },
      denials_per_run: stats.denials_per_run,
      cache_hit_rate,
      caching_multiplier,
      total_cost_usd: stats.total_cost_usd,
      first_recorded_at: stats.first_recorded_at,
      last_recorded_at: stats.last_recorded_at,
    }),
    { headers: { "content-type": "application/json" } }
  );
}

async function handleRuns(url, env) {
  const searchParams = url.searchParams;
  let limit = 100;
  const limitParam = searchParams.get("limit");
  if (limitParam !== null) {
    if (!/^[1-9]\d*$/.test(limitParam)) {
      return new Response(JSON.stringify({ error: "invalid limit" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const parsedLimit = Number(limitParam);
    if (parsedLimit > 1000) {
      return new Response(JSON.stringify({ error: "invalid limit" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    limit = parsedLimit;
  }

  const conditions = [];
  const bindings = [];

  const repository = searchParams.get("repository");
  if (repository !== null) {
    conditions.push("repository = ?");
    bindings.push(repository);
  }

  const roundType = searchParams.get("round_type");
  if (roundType !== null) {
    conditions.push("round_type = ?");
    bindings.push(roundType);
  }

  const since = searchParams.get("since");
  if (since !== null) {
    conditions.push("recorded_at >= ?");
    bindings.push(since);
  }

  const until = searchParams.get("until");
  if (until !== null) {
    conditions.push("recorded_at <= ?");
    bindings.push(until);
  }

  const cursor = searchParams.get("cursor");
  if (cursor !== null) {
    conditions.push("recorded_at < ?");
    bindings.push(cursor);
  }

  let query = `SELECT
    session_id,
    recorded_at,
    repository,
    pr_number,
    pr_url,
    head_sha,
    run_id,
    run_attempt,
    run_url,
    round_type,
    model,
    input_tokens,
    output_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    total_cost_usd,
    duration_ms,
    duration_api_ms,
    num_turns,
    permission_denials,
    changed_files,
    diff_lines,
    per_model_usage,
    subagent_stats,
    raw_result
  FROM usage_records`;

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  query += ` ORDER BY recorded_at DESC LIMIT ?`;
  bindings.push(limit);

  const { results } = await env.DB.prepare(query).bind(...bindings).all();
  const rows = results ?? [];
  const nextCursor = rows.length > 0 ? rows[rows.length - 1].recorded_at : null;

  return new Response(
    JSON.stringify({
      rows,
      next_cursor: nextCursor,
    }),
    { headers: { "content-type": "application/json" } }
  );
}

async function handleIngest(request, env) {
  // Reject missing or empty secret to prevent open access (#41).
  const token = env?.REVIEW_TELEMETRY_TOKEN;
  const authHeader = request.headers.get("authorization");
  if (!token || !authHeader || !timingSafeEqual(authHeader, `Bearer ${token}`)) {
    return new Response(null, { status: 401 });
  }

  const MAX_INGEST_BYTES = 256 * 1024;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = parseInt(contentLength, 10);
    if (Number.isNaN(length) || length > MAX_INGEST_BYTES) {
      return new Response(null, { status: 413 });
    }
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return new Response(null, { status: 400 });
  }

  if (new TextEncoder().encode(rawBody).length > MAX_INGEST_BYTES) {
    return new Response(null, { status: 413 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.session_id !== "string" ||
    typeof payload.repository !== "string"
  ) {
    return new Response(null, { status: 400 });
  }

  // Name columns literally so unmapped payload fields are dropped (#41).
  // Protect against retried POST requests without re-running (#41).
  try {
    await env.DB.prepare(
      `INSERT INTO usage_records (
        session_id,
        recorded_at,
        repository,
        pr_number,
        pr_url,
        head_sha,
        run_id,
        run_attempt,
        run_url,
        round_type,
        model,
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
        total_cost_usd,
        duration_ms,
        duration_api_ms,
        num_turns,
        permission_denials,
        changed_files,
        diff_lines,
        per_model_usage,
        subagent_stats,
        raw_result
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
      ON CONFLICT(session_id) DO NOTHING`
    ).bind(
      payload.session_id,
      payload.recorded_at ?? new Date().toISOString(),
      payload.repository,
      payload.pr_number ?? null,
      payload.pr_url ?? null,
      payload.head_sha ?? null,
      payload.run_id ?? null,
      payload.run_attempt ?? null,
      payload.run_url ?? null,
      payload.round_type ?? null,
      payload.model ?? null,
      payload.input_tokens ?? null,
      payload.output_tokens ?? null,
      payload.cache_read_input_tokens ?? null,
      payload.cache_creation_input_tokens ?? null,
      payload.total_cost_usd ?? null,
      payload.duration_ms ?? null,
      payload.duration_api_ms ?? null,
      payload.num_turns ?? null,
      payload.permission_denials ?? null,
      payload.changed_files ?? null,
      payload.diff_lines ?? null,
      serializeJson(payload.per_model_usage, "{}"),
      serializeJson(payload.subagent_stats, null),
      serializeJson(payload.raw_result, null)
    ).run();
  } catch {
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 204 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (method === "POST" && (pathname === "/ingest" || pathname === "/")) {
      return handleIngest(request, env);
    }

    if (method === "GET" && (pathname === "/api/summary" || pathname === "/api/runs")) {
      const authError = await verifyAccess(request, env);
      if (authError) {
        return authError;
      }
      if (pathname === "/api/summary") {
        return handleSummary(env);
      }
      return handleRuns(url, env);
    }

    return new Response(null, { status: 404 });
  },
};
