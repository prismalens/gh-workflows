let cachedCerts = null;
let certsExpiry = 0;
let lastRefetchTime = 0;

// D1 refuses a row over 2,000,000 bytes. Every stored column is re-serialised
// from this body and re-serialising never grows it, so half the row limit keeps
// the insert inside D1's ceiling with the other half as headroom. Picking the
// bound from the row limit is what makes an over-size payload a 413 here rather
// than a 500 from the insert. Story: #60.
const D1_MAX_ROW_BYTES = 2_000_000;
const MAX_INGEST_BYTES = D1_MAX_ROW_BYTES / 2;

const READ_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "vary": "Cf-Access-Jwt-Assertion",
};

const NUMERIC_FIELDS = [
  "pr_number",
  "run_id",
  "run_attempt",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_cost_usd",
  "duration_ms",
  "duration_api_ms",
  "num_turns",
  "permission_denials",
  "changed_files",
  "diff_lines",
  "inline_count",
  "summary_count",
  "round_ordinal",
];

const STRING_FIELDS = [
  "recorded_at",
  "pr_url",
  "head_sha",
  "run_url",
  "round_type",
  "model",
  "lane_version",
  "verdict_kind",
  "verdict_text",
  "fallback_reason",
  "range_base",
  "range_head",
  "model_source",
  "job_conclusion",
  "pr_title",
  "pr_author",
  "pr_state",
  "pr_base_ref",
  "pr_head_ref",
];

const JSON_ARRAY_FIELDS = ["comment_node_ids"];
const JSON_OBJECT_FIELDS = ["config_resolution"];

const VALID_LANE_EVENT_REASONS = new Set([
  "no-token",
  "auto-paused",
  "fork-head",
  "skip-author",
]);

const LANE_EVENT_NUMERIC_FIELDS = [
  "pr_number",
  "rounds_used",
];

const LANE_EVENT_STRING_FIELDS = [
  "recorded_at",
  "head_sha",
  "run_url",
  "lane_version",
];

const CANARY_STRING_FIELDS = [
  "last_seen_at",
  "recorded_at",
  "run_url",
  "lane_version",
];

function truncateString(val, maxLen = 512) {
  if (typeof val !== "string") {
    return null;
  }
  return val.length > maxLen ? val.slice(0, maxLen) : val;
}

function serializeJson(val, fallback) {
  if (val === undefined || val === null) {
    return fallback;
  }
  return typeof val === "string" ? val : JSON.stringify(val);
}

// Accepts a value already of the given shape, or a string that parses to it.
// Absent/null is left to the caller, which stores NULL for those (#98 finding 2).
function isValidJsonShape(val, kind) {
  if (val === undefined || val === null) {
    return true;
  }
  let parsed = val;
  if (typeof val === "string") {
    try {
      parsed = JSON.parse(val);
    } catch {
      return false;
    }
  }
  if (kind === "array") {
    return Array.isArray(parsed);
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

// crypto.subtle.timingSafeEqual is a Workers extension, not a web standard, so it
// is probed rather than assumed: an older compatibility date or a non-Workers
// runtime running this file falls through to the XOR loop. Story: #60.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // The primitive throws on a length mismatch, and length is not a secret here.
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  if (typeof crypto?.subtle?.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(aBytes, bBytes);
  }
  let acc = 0;
  for (let i = 0; i < aBytes.length; i++) {
    acc |= aBytes[i] ^ bBytes[i];
  }
  return acc === 0;
}

/**
 * Reads the body, stopping at `max` bytes. Returns null once the stream goes
 * past the bound. `request.text()` would buffer the whole thing first, so a
 * caller omitting content-length could make the Worker hold an unbounded body
 * in memory before the size check ever ran. Story: #60.
 */
async function readBoundedText(request, max) {
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > max) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
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

async function getSigningKeys(teamDomain, force = false) {
  const now = Date.now();
  if (!force && cachedCerts && now < certsExpiry) {
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
  lastRefetchTime = now;
  return cachedCerts;
}

// Origin requests bypass Access; validate JWT directly to keep read routes closed (#46).
async function verifyAccess(request, env) {
  const teamDomain = env?.ACCESS_TEAM_DOMAIN;
  const expectedAud = env?.ACCESS_AUD;
  if (!teamDomain || !expectedAud) {
    return new Response(JSON.stringify({ error: "read API not configured" }), {
      status: 503,
      headers: READ_HEADERS,
    });
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
    });
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
    });
  }

  let header, payload;
  try {
    header = parseJwtPart(parts[0]);
    payload = parseJwtPart(parts[1]);
  } catch {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
    });
  }

  if (header?.alg !== "RS256" || !header?.kid) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
    });
  }

  let keys;
  try {
    keys = await getSigningKeys(teamDomain);
  } catch {
    return new Response(JSON.stringify({ error: "failed to fetch signing keys" }), {
      status: 503,
      headers: READ_HEADERS,
    });
  }

  let matchingKey = keys.find((k) => k.kid === header.kid);
  if (!matchingKey && Date.now() - lastRefetchTime >= 60 * 1000) {
    try {
      keys = await getSigningKeys(teamDomain, true);
      matchingKey = keys.find((k) => k.kid === header.kid);
    } catch {
      return new Response(JSON.stringify({ error: "failed to fetch signing keys" }), {
        status: 503,
        headers: READ_HEADERS,
      });
    }
  }

  if (!matchingKey) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
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
        headers: READ_HEADERS,
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
    });
  }

  const aud = payload?.aud;
  const hasAud = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (!hasAud) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload?.exp !== "number" || payload.exp <= now) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
    });
  }

  if (payload?.iss !== `https://${teamDomain}`) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: READ_HEADERS,
    });
  }

  return null;
}

async function handleSummary(env) {
  const canaryRow = await env.DB.prepare(
    "SELECT last_seen_at FROM canary_pings WHERE id = 'canary' LIMIT 1"
  ).first();
  const canary_last_seen_at = canaryRow ? canaryRow.last_seen_at : null;

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
        verdict_kinds: {},
        fallback_reasons: {},
        model_sources: {},
        canary_last_seen_at,
      }),
      { headers: READ_HEADERS }
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
    let offset = Math.max(0, Math.ceil(countRow.cnt * 0.95) - 1);
    let p95Row = await env.DB.prepare(
      "SELECT duration_ms FROM usage_records WHERE duration_ms IS NOT NULL ORDER BY duration_ms ASC LIMIT 1 OFFSET ?"
    ).bind(offset).first();
    if (!p95Row) {
      const currentCountRow = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM usage_records WHERE duration_ms IS NOT NULL"
      ).first();
      if (currentCountRow && currentCountRow.cnt > 0) {
        const clampedOffset = Math.max(0, Math.min(offset, currentCountRow.cnt - 1));
        p95Row = await env.DB.prepare(
          "SELECT duration_ms FROM usage_records WHERE duration_ms IS NOT NULL ORDER BY duration_ms ASC LIMIT 1 OFFSET ?"
        ).bind(clampedOffset).first();
      }
    }
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

  const verdictRows = await env.DB.prepare(
    "SELECT verdict_kind, COUNT(*) as cnt FROM usage_records WHERE verdict_kind IS NOT NULL GROUP BY verdict_kind ORDER BY verdict_kind"
  ).all();
  const verdict_kinds = {};
  for (const r of verdictRows.results ?? []) {
    verdict_kinds[r.verdict_kind] = r.cnt;
  }

  const fallbackRows = await env.DB.prepare(
    "SELECT fallback_reason, COUNT(*) as cnt FROM usage_records WHERE fallback_reason IS NOT NULL GROUP BY fallback_reason ORDER BY fallback_reason"
  ).all();
  const fallback_reasons = {};
  for (const r of fallbackRows.results ?? []) {
    fallback_reasons[r.fallback_reason] = r.cnt;
  }

  const modelSourceRows = await env.DB.prepare(
    "SELECT model_source, COUNT(*) as cnt FROM usage_records WHERE model_source IS NOT NULL GROUP BY model_source ORDER BY model_source"
  ).all();
  const model_sources = {};
  for (const r of modelSourceRows.results ?? []) {
    model_sources[r.model_source] = r.cnt;
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
      verdict_kinds,
      fallback_reasons,
      model_sources,
      canary_last_seen_at,
    }),
    { headers: READ_HEADERS }
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
        headers: READ_HEADERS,
      });
    }
    const parsedLimit = Number(limitParam);
    if (parsedLimit > 1000) {
      return new Response(JSON.stringify({ error: "invalid limit" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    limit = parsedLimit;
  }

  const includeParam = searchParams.get("include");
  let includeBlobs = false;
  if (includeParam !== null) {
    if (includeParam !== "blobs") {
      return new Response(JSON.stringify({ error: "invalid include" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    includeBlobs = true;
    limit = Math.min(limit, 50);
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
    const pipeIndex = cursor.indexOf("|");
    if (pipeIndex === -1) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    const cursorRecordedAt = cursor.slice(0, pipeIndex);
    const cursorSessionId = cursor.slice(pipeIndex + 1);
    if (!cursorRecordedAt || !cursorSessionId) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    conditions.push("(recorded_at < ? OR (recorded_at = ? AND session_id < ?))");
    bindings.push(cursorRecordedAt, cursorRecordedAt, cursorSessionId);
  }

  const columns = [
    "session_id",
    "recorded_at",
    "repository",
    "pr_number",
    "pr_url",
    "head_sha",
    "run_id",
    "run_attempt",
    "run_url",
    "round_type",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "total_cost_usd",
    "duration_ms",
    "duration_api_ms",
    "num_turns",
    "permission_denials",
    "changed_files",
    "diff_lines",
    "lane_version",
    "verdict_kind",
    "inline_count",
    "summary_count",
    "round_ordinal",
    "fallback_reason",
    "range_base",
    "range_head",
    "model_source",
    "job_conclusion",
    "pr_title",
    "pr_author",
    "pr_state",
    "pr_base_ref",
    "pr_head_ref",
  ];
  if (includeBlobs) {
    columns.push(
      "per_model_usage",
      "subagent_stats",
      "raw_result",
      "verdict_text",
      "comment_node_ids",
      "config_resolution"
    );
  }

  let query = `SELECT
    ${columns.join(",\n    ")}
  FROM usage_records`;

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  query += ` ORDER BY recorded_at DESC, session_id DESC LIMIT ?`;
  bindings.push(limit);

  const { results } = await env.DB.prepare(query).bind(...bindings).all();
  const rows = results ?? [];
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? `${rows[rows.length - 1].recorded_at}|${rows[rows.length - 1].session_id}`
      : null;

  return new Response(
    JSON.stringify({
      rows,
      next_cursor: nextCursor,
    }),
    { headers: READ_HEADERS }
  );
}

async function handleLaneEvents(url, env) {
  const searchParams = url.searchParams;
  let limit = 100;
  const limitParam = searchParams.get("limit");
  if (limitParam !== null) {
    if (!/^[1-9]\d*$/.test(limitParam)) {
      return new Response(JSON.stringify({ error: "invalid limit" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    const parsedLimit = Number(limitParam);
    if (parsedLimit > 1000) {
      return new Response(JSON.stringify({ error: "invalid limit" }), {
        status: 400,
        headers: READ_HEADERS,
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
    const pipeIndex = cursor.indexOf("|");
    if (pipeIndex === -1) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    const cursorRecordedAt = cursor.slice(0, pipeIndex);
    const cursorRunId = cursor.slice(pipeIndex + 1);
    if (!cursorRecordedAt || !cursorRunId || !/^\d+$/.test(cursorRunId)) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    conditions.push("(recorded_at < ? OR (recorded_at = ? AND run_id < ?))");
    bindings.push(cursorRecordedAt, cursorRecordedAt, Number(cursorRunId));
  }

  const columns = [
    "run_id",
    "run_attempt",
    "recorded_at",
    "repository",
    "reason",
    "pr_number",
    "head_sha",
    "run_url",
    "rounds_used",
    "lane_version",
  ];

  let query = `SELECT
    ${columns.join(",\n    ")}
  FROM lane_events`;

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  query += ` ORDER BY recorded_at DESC, run_id DESC LIMIT ?`;
  bindings.push(limit);

  const { results } = await env.DB.prepare(query).bind(...bindings).all();
  const rows = results ?? [];
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? `${rows[rows.length - 1].recorded_at}|${rows[rows.length - 1].run_id}`
      : null;

  return new Response(
    JSON.stringify({
      rows,
      next_cursor: nextCursor,
    }),
    { headers: READ_HEADERS }
  );
}

async function handleIngest(request, env) {
  // Reject missing or empty secret to prevent open access (#41).
  const token = env?.REVIEW_TELEMETRY_TOKEN;
  const authHeader = request.headers.get("authorization");
  if (!token || !authHeader || !timingSafeEqual(authHeader, `Bearer ${token}`)) {
    return new Response(null, { status: 401 });
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = parseInt(contentLength, 10);
    if (Number.isNaN(length) || length > MAX_INGEST_BYTES) {
      return new Response(null, { status: 413 });
    }
  }

  let rawBody;
  try {
    rawBody = await readBoundedText(request, MAX_INGEST_BYTES);
  } catch {
    return new Response(null, { status: 400 });
  }

  // null means the stream went past the bound, which a caller omitting
  // content-length is otherwise free to do.
  if (rawBody === null) {
    return new Response(null, { status: 413 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return new Response(null, { status: 400 });
  }

  const eventKind = payload.event_kind;

  if (eventKind === undefined || eventKind === "usage_record") {
    if (
      typeof payload.session_id !== "string" ||
      typeof payload.repository !== "string"
    ) {
      return new Response(null, { status: 400 });
    }

    for (const field of NUMERIC_FIELDS) {
      const val = payload[field];
      if (val !== undefined && val !== null && (typeof val !== "number" || !Number.isFinite(val))) {
        return new Response(JSON.stringify({ error: "invalid field types" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    for (const field of STRING_FIELDS) {
      const val = payload[field];
      if (val !== undefined && val !== null && typeof val !== "string") {
        return new Response(JSON.stringify({ error: "invalid field types" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    for (const field of JSON_ARRAY_FIELDS) {
      if (!isValidJsonShape(payload[field], "array")) {
        return new Response(JSON.stringify({ error: "invalid field types" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    for (const field of JSON_OBJECT_FIELDS) {
      if (!isValidJsonShape(payload[field], "object")) {
        return new Response(JSON.stringify({ error: "invalid field types" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
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
          raw_result,
          lane_version,
          verdict_kind,
          verdict_text,
          inline_count,
          summary_count,
          comment_node_ids,
          fallback_reason,
          range_base,
          range_head,
          model_source,
          config_resolution,
          job_conclusion,
          round_ordinal,
          pr_title,
          pr_author,
          pr_state,
          pr_base_ref,
          pr_head_ref
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
          ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
          ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40,
          ?41, ?42, ?43
        )
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
        serializeJson(payload.raw_result, null),
        payload.lane_version ?? null,
        payload.verdict_kind ?? null,
        payload.verdict_text ?? null,
        payload.inline_count ?? null,
        payload.summary_count ?? null,
        serializeJson(payload.comment_node_ids, null),
        payload.fallback_reason ?? null,
        payload.range_base ?? null,
        payload.range_head ?? null,
        payload.model_source ?? null,
        serializeJson(payload.config_resolution, null),
        payload.job_conclusion ?? null,
        payload.round_ordinal ?? null,
        truncateString(payload.pr_title, 512),
        truncateString(payload.pr_author, 512),
        payload.pr_state ?? null,
        truncateString(payload.pr_base_ref, 512),
        truncateString(payload.pr_head_ref, 512)
      ).run();
    } catch {
      return new Response(null, { status: 500 });
    }

    return new Response(null, { status: 204 });
  }

  if (eventKind === "lane_event") {
    if (
      typeof payload.repository !== "string" ||
      typeof payload.reason !== "string" ||
      typeof payload.run_id !== "number" ||
      !Number.isFinite(payload.run_id) ||
      typeof payload.run_attempt !== "number" ||
      !Number.isFinite(payload.run_attempt)
    ) {
      return new Response(JSON.stringify({ error: "missing or invalid required fields" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    if (!VALID_LANE_EVENT_REASONS.has(payload.reason)) {
      return new Response(JSON.stringify({ error: "invalid reason" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    for (const field of LANE_EVENT_NUMERIC_FIELDS) {
      const val = payload[field];
      if (val !== undefined && val !== null && (typeof val !== "number" || !Number.isFinite(val))) {
        return new Response(JSON.stringify({ error: "invalid field types" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    for (const field of LANE_EVENT_STRING_FIELDS) {
      const val = payload[field];
      if (val !== undefined && val !== null && typeof val !== "string") {
        return new Response(JSON.stringify({ error: "invalid field types" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    try {
      await env.DB.prepare(
        `INSERT INTO lane_events (
          run_id,
          run_attempt,
          recorded_at,
          repository,
          reason,
          pr_number,
          head_sha,
          run_url,
          rounds_used,
          lane_version
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(run_id, run_attempt) DO NOTHING`
      ).bind(
        payload.run_id,
        payload.run_attempt,
        payload.recorded_at ?? new Date().toISOString(),
        payload.repository,
        payload.reason,
        payload.pr_number ?? null,
        payload.head_sha ?? null,
        payload.run_url ?? null,
        payload.rounds_used ?? null,
        payload.lane_version ?? null
      ).run();
    } catch {
      return new Response(null, { status: 500 });
    }

    return new Response(null, { status: 204 });
  }

  if (eventKind === "canary") {
    for (const field of CANARY_STRING_FIELDS) {
      const val = payload[field];
      if (val !== undefined && val !== null && typeof val !== "string") {
        return new Response(JSON.stringify({ error: "invalid field types" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const lastSeenAt = payload.last_seen_at ?? payload.recorded_at ?? new Date().toISOString();

    try {
      await env.DB.prepare(
        `INSERT INTO canary_pings (
          id,
          last_seen_at,
          run_url,
          lane_version
        ) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          run_url = excluded.run_url,
          lane_version = excluded.lane_version`
      ).bind(
        "canary",
        lastSeenAt,
        payload.run_url ?? null,
        payload.lane_version ?? null
      ).run();
    } catch {
      return new Response(null, { status: 500 });
    }

    return new Response(null, { status: 204 });
  }

  return new Response(JSON.stringify({ error: "invalid event_kind" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

async function handleGetChanges(url, env) {
  const searchParams = url.searchParams;
  let limit = 100;
  const limitParam = searchParams.get("limit");
  if (limitParam !== null) {
    if (!/^[1-9]\d*$/.test(limitParam)) {
      return new Response(JSON.stringify({ error: "invalid limit" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    const parsedLimit = Number(limitParam);
    if (parsedLimit > 1000) {
      return new Response(JSON.stringify({ error: "invalid limit" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    limit = parsedLimit;
  }

  const conditions = [];
  const bindings = [];

  const cursor = searchParams.get("cursor");
  if (cursor !== null) {
    const pipeIndex = cursor.indexOf("|");
    if (pipeIndex === -1) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    const cursorAt = cursor.slice(0, pipeIndex);
    const cursorId = cursor.slice(pipeIndex + 1);
    if (!cursorAt || !cursorId) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    conditions.push("(at < ? OR (at = ? AND id < ?))");
    bindings.push(cursorAt, cursorAt, cursorId);
  }

  const columns = [
    "id",
    "name",
    "at",
    "source_url",
    "scope",
    "repository",
    "created_at",
  ];

  let query = `SELECT
    ${columns.join(",\n    ")}
  FROM changes`;

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  query += ` ORDER BY at DESC, id DESC LIMIT ?`;
  bindings.push(limit);

  const { results } = await env.DB.prepare(query).bind(...bindings).all();
  const rows = results ?? [];
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? `${rows[rows.length - 1].at}|${rows[rows.length - 1].id}`
      : null;

  return new Response(
    JSON.stringify({
      rows,
      next_cursor: nextCursor,
    }),
    { headers: READ_HEADERS }
  );
}

async function handlePostChanges(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json body" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return new Response(JSON.stringify({ error: "invalid body" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  // name: required, non-empty, capped at 200 characters
  if (typeof payload.name !== "string" || payload.name.length === 0 || payload.name.length > 200) {
    return new Response(JSON.stringify({ error: "invalid or missing name" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  // at: required and must parse as an ISO 8601 instant; store it normalised to UTC
  if (typeof payload.at !== "string") {
    return new Response(JSON.stringify({ error: "invalid or missing at" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }
  const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/i;
  if (!isoInstantPattern.test(payload.at)) {
    return new Response(JSON.stringify({ error: "invalid at format" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }
  const atDate = new Date(payload.at);
  if (Number.isNaN(atDate.getTime())) {
    return new Response(JSON.stringify({ error: "invalid at timestamp" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }
  const normalizedAt = atDate.toISOString();

  // scope: required and exactly repo or fleet
  if (payload.scope !== "repo" && payload.scope !== "fleet") {
    return new Response(JSON.stringify({ error: "invalid scope" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  // repository: required when scope is repo, and must be absent or null when scope is fleet
  if (payload.scope === "repo") {
    if (typeof payload.repository !== "string" || payload.repository.length === 0) {
      return new Response(JSON.stringify({ error: "repository required for repo scope" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
  } else if (payload.scope === "fleet") {
    if (payload.repository !== undefined && payload.repository !== null) {
      return new Response(JSON.stringify({ error: "repository must be absent or null for fleet scope" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
  }

  // source_url: optional, and when present must be https:// and capped at 500 characters
  if (payload.source_url !== undefined && payload.source_url !== null) {
    if (
      typeof payload.source_url !== "string" ||
      !payload.source_url.startsWith("https://") ||
      payload.source_url.length > 500
    ) {
      return new Response(JSON.stringify({ error: "invalid source_url" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const repository = payload.scope === "repo" ? payload.repository : null;
  const sourceUrl = payload.source_url ?? null;

  try {
    await env.DB.prepare(
      `INSERT INTO changes (
        id,
        name,
        at,
        source_url,
        scope,
        repository,
        created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(
      id,
      payload.name,
      normalizedAt,
      sourceUrl,
      payload.scope,
      repository,
      createdAt
    ).run();
  } catch {
    return new Response(null, { status: 500 });
  }

  const createdRow = {
    id,
    name: payload.name,
    at: normalizedAt,
    source_url: sourceUrl,
    scope: payload.scope,
    repository,
    created_at: createdAt,
  };

  return new Response(JSON.stringify(createdRow), {
    status: 201,
    headers: READ_HEADERS,
  });
}

async function handleDeleteChange(id, env) {
  try {
    await env.DB.prepare("DELETE FROM changes WHERE id = ?").bind(id).run();
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

    if (
      method === "GET" &&
      (pathname === "/api/summary" || pathname === "/api/runs" || pathname === "/api/lane-events")
    ) {
      const authError = await verifyAccess(request, env);
      if (authError) {
        return authError;
      }
      if (pathname === "/api/summary") {
        return handleSummary(env);
      }
      if (pathname === "/api/runs") {
        return handleRuns(url, env);
      }
      if (pathname === "/api/lane-events") {
        return handleLaneEvents(url, env);
      }
    }

    if (pathname === "/api/changes" || pathname.startsWith("/api/changes/")) {
      const authError = await verifyAccess(request, env);
      if (authError) {
        return authError;
      }
      if (method === "GET" && pathname === "/api/changes") {
        return handleGetChanges(url, env);
      }
      if (method === "POST" && pathname === "/api/changes") {
        return handlePostChanges(request, env);
      }
      if (method === "DELETE" && pathname.startsWith("/api/changes/")) {
        const id = pathname.slice("/api/changes/".length);
        if (!id) {
          return new Response(JSON.stringify({ error: "missing id" }), {
            status: 400,
            headers: READ_HEADERS,
          });
        }
        return handleDeleteChange(id, env);
      }
      return new Response(null, { status: 404 });
    }

    // run_worker_first routes GET / here so POST / keeps reaching the ingest
    // handler, so the SPA shell has to be served from the Worker (#46). Assets
    // answer GET and HEAD only; the API and ingest paths stay 404 rather than
    // returning HTML to a caller that asked for JSON.
    const wantsAsset =
      (method === "GET" || method === "HEAD") &&
      pathname !== "/ingest" &&
      pathname !== "/api" &&
      !pathname.startsWith("/api/");
    if (wantsAsset && env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(null, { status: 404 });
  },
};
