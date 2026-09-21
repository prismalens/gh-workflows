import { jwtVerify, createRemoteJWKSet } from "jose";

let cachedCerts = null;
let certsExpiry = 0;
let lastRefetchTime = 0;

const GITHUB_ACTIONS_JWKS = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks")
);
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

// D1 refuses a row over 2,000,000 bytes. Every stored column is re-serialised
// from this body and re-serialising never grows it, so half the row limit keeps
// the insert inside D1's ceiling with the other half as headroom. Picking the
// bound from the row limit is what makes an over-size payload a 413 here rather
// than a 500 from the insert. Story: #60.
const D1_MAX_ROW_BYTES = 2_000_000;
// Half of round_agents' primary key. Truncating it would merge two agents. Story: #93.
const AGENT_ID_MAX_LENGTH = 512;
const MAX_INGEST_BYTES = D1_MAX_ROW_BYTES / 2;

// The zone-level WAF rule (wrangler.toml) is what protects the free-plan request
// quota, since by the time this runs the request is already counted. This binding
// is the second line: it bounds D1 write load and token-guessing per IP even if
// the zone rule is ever loosened or removed. Story: #60.
async function isIngestRateLimited(request, env) {
  const limiter = env?.INGEST_RATE_LIMITER;
  if (!limiter) {
    return false;
  }
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key });
  return !success;
}

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
  "reviewable_lines",
  "size_override",
  "context_repositories",
  "context_lines",
  // #174: account/auth/quota failure classification.
  "failure_retryable",
  "api_error_status",
  // #174: telemetry backfill for #90's unmerged base PR.
  "base_pr_number",
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
  "prompt_hash",
  "action_version",
  "config_hash",
  "variant",
  "agents_status",
  // #101: review effort level, orthogonal to model. Not enumed here; low is
  // schema-rejected in the workflow for this release, not the worker, so a
  // later release enabling it needs no worker change.
  "level",
  "level_source",
  // #174: account/auth/quota failure classification, and reset time when parsed.
  "failure_class",
  "failure_reset_at",
  "credential_type",
  // #174: telemetry backfill for #162's restack fingerprint.
  "patch_fingerprint",
];

const JSON_ARRAY_FIELDS = ["comment_node_ids"];
// #75: config_effective is lane-authored config, stored as-is; never parsed into a
// fixed key set, so a new config key needs no worker change.
const JSON_OBJECT_FIELDS = ["config_resolution", "config_effective"];

const VALID_LANE_EVENT_REASONS = new Set([
  "no-token",
  "auto-paused",
  "paused-by-request", // #124, finding 3944010353
  "fork-head",
  "skip-author",
  "refused-size", // #105: reviewable_lines exceeded max_reviewable_lines, nothing posted
  "draft", // #153: a summon on a draft spends a run and reviews nothing
  "skip-trivial", // #154: min_diff_lines floor
  "superseded", // #154: debounce_minutes lever
  "unchanged-patch", // #162: restack with unchanged patch
  "api-error", // #174: account, auth or quota failure; the class is on usage_records.failure_class
  "admission-off", // #189: review.admission is off
  "skip-label", // #189: claude_review_skip on the pull request
  "awaiting-label", // #189: admission by label and claude_review absent
]);

// A round that did not run writes no usage_records row, so its verdict never
// reached verdict_kinds until now. fork-head and skip-author map to nothing:
// no liveness verdict is posted for either (#176).
const LANE_REASON_TO_VERDICT_KIND = {
  "auto-paused": "auto-paused",
  "paused-by-request": "paused-by-request",
  "skip-trivial": "skipped-trivial",
  superseded: "superseded",
  "unchanged-patch": "unchanged-patch",
  draft: "draft",
  "refused-size": "refused-size",
  "no-token": "no-token",
  "api-error": "api-error",
  "skip-label": "skip-label",
  "awaiting-label": "awaiting-label",
};

const LANE_EVENT_NUMERIC_FIELDS = [
  "pr_number",
  "rounds_used",
  "reviewable_lines",
  "max_reviewable_lines",
];

const LANE_EVENT_STRING_FIELDS = [
  "recorded_at",
  "head_sha",
  "run_url",
  "lane_version",
  // #124: the login that issued @claude pause, read by the lane from the event
  // payload rather than comment text. Null on every reason but paused-by-request.
  "actor",
];

const VALID_PR_STATES = new Set(["open", "closed", "merged"]);
const VALID_PR_SOURCES = new Set(["round", "hook", "reconciler"]);

const PR_STRING_FIELDS = [
  "title",
  "author",
  "base_ref",
  "head_ref",
  "head_sha",
  "merged_at",
  "closed_at",
  "updated_at", // #136, finding 3944010389
];

// #47: exactly the ruled schema, plus row_set_incomplete (the sweep-pagination flag the
// schema amendment predates). Any field the sweep sends outside this list is ignored, never
// stored, which is what keeps a severity or lane column from ever reaching this table.
const FINDING_STRING_FIELDS = [
  "thread_node_id",
  "repository",
  "path",
  "resolved_by_login",
  "thread_created_at",
  "header_raw",
  "body_excerpt",
  "diff_hunk",
  "human_reply_sha",
  "fix_sha",
  "fix_sha_source",
  "verify_verdict",
  "head_sha_reviewed",
  "last_swept_at",
];

const FINDING_INTEGER_FIELDS = [
  "pr_number",
  "original_line",
  "line",
  "is_resolved",
  "is_outdated",
  "human_reply_count",
  "row_set_incomplete",
];

// Nullable per the schema amendment; every other field in FINDING_STRING_FIELDS is required.
const FINDING_NULLABLE_STRING_FIELDS = new Set([
  "path",
  "resolved_by_login",
  "header_raw",
  "human_reply_sha",
  "fix_sha",
  "fix_sha_source",
  "verify_verdict",
]);

// Nullable per the schema amendment; every other field in FINDING_INTEGER_FIELDS is required.
const FINDING_NULLABLE_INTEGER_FIELDS = new Set(["original_line", "line"]);

const VALID_FIX_SHA_SOURCES = new Set(["verify_table", "human_reply"]);
const VALID_VERIFY_VERDICTS = new Set(["fixed", "still_applies", "cannot_verify"]);

function truncateString(val, maxLen = 512) {
  if (typeof val !== "string") {
    return null;
  }
  if (val.length <= maxLen) {
    return val;
  }
  let end = maxLen;
  // A cut exactly between a surrogate pair leaves a lone high surrogate, which has no
  // valid UTF-8 encoding: D1's bind and any later TextEncoder pass replace it with U+FFFD
  // rather than throw, silently corrupting the last character. header_raw/body_excerpt/
  // diff_hunk (#47) are PR comment text a person wrote and can contain any Unicode,
  // including astral characters (emoji) that land on this boundary by chance.
  const code = val.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return val.slice(0, end);
}

function toIntegerOrNull(val) {
  return typeof val === "number" && Number.isInteger(val) ? val : null;
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

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The ingest route accepts arbitrary strings for every component, so no separator byte is
// safe to join on: a component containing it would collide with a different set of
// components. JSON encodes the array unambiguously and keeps null distinct from "". #47.
async function computeVariantKey(promptHash, model, actionVersion, configHash, roundType) {
  const components = [promptHash, model, actionVersion, configHash, roundType].map((c) =>
    c === null || c === undefined ? null : String(c)
  );
  return sha256Hex(JSON.stringify(components));
}

// Accepts either shared secret bearer or GitHub Actions OIDC JWT (#176).
async function authenticateIngest(request, env, { getKey } = {}) {
  const authHeader = request.headers.get("authorization");
  const token = env?.REVIEW_TELEMETRY_TOKEN;

  if (token && authHeader && timingSafeEqual(authHeader, `Bearer ${token}`)) {
    return { method: "bearer" };
  }

  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const tokenStr = authHeader.replace(/^Bearer\s+/i, "").trim();
    try {
      const keySource = getKey || GITHUB_ACTIONS_JWKS;
      const { payload } = await jwtVerify(tokenStr, keySource, {
        issuer: GITHUB_ACTIONS_ISSUER,
        audience: new URL(request.url).origin,
        algorithms: ["RS256"],
      });

      if (!payload.repository || typeof payload.repository !== "string") {
        return new Response(null, { status: 401 });
      }

      // OIDC allowlist: only approved repository IDs may write telemetry (#177).
      // Unset or empty var rejects all OIDC tokens fail-closed (#177).
      const allowedIds = (env?.OIDC_ALLOWED_REPOSITORY_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const repoIdStr =
        payload.repository_id !== undefined && payload.repository_id !== null
          ? String(payload.repository_id)
          : "";
      if (!repoIdStr || !allowedIds.includes(repoIdStr)) {
        return new Response(JSON.stringify({ error: "repository not allowed" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }

      return {
        method: "oidc",
        repository: payload.repository,
        repository_id: payload.repository_id ?? null,
        repository_owner_id: payload.repository_owner_id ?? null,
        job_workflow_ref: payload.job_workflow_ref ?? null,
        run_id: payload.run_id ?? null,
      };
    } catch {
      return new Response(null, { status: 401 });
    }
  }

  return new Response(null, { status: 401 });
}

export { computeVariantKey, authenticateIngest, LANE_REASON_TO_VERDICT_KIND };

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

// Three stable codes so the client can tell the causes apart instead of reading
// the same body for each. Status codes are unchanged. Story: #96.
function accessError(code, status) {
  return new Response(JSON.stringify({ error: code }), { status, headers: READ_HEADERS });
}

// Origin requests bypass Access; validate JWT directly to keep read routes closed (#46).
async function verifyAccess(request, env) {
  const teamDomain = env?.ACCESS_TEAM_DOMAIN;
  const expectedAud = env?.ACCESS_AUD;
  if (!teamDomain || !expectedAud) {
    return accessError("access_unconfigured", 503);
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return accessError("access_denied", 403);
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return accessError("access_denied", 403);
  }

  let header, payload;
  try {
    header = parseJwtPart(parts[0]);
    payload = parseJwtPart(parts[1]);
  } catch {
    return accessError("access_denied", 403);
  }

  if (header?.alg !== "RS256" || !header?.kid) {
    return accessError("access_denied", 403);
  }

  let keys;
  try {
    keys = await getSigningKeys(teamDomain);
  } catch {
    return accessError("access_keys_unavailable", 503);
  }

  let matchingKey = keys.find((k) => k.kid === header.kid);
  if (!matchingKey && Date.now() - lastRefetchTime >= 60 * 1000) {
    try {
      keys = await getSigningKeys(teamDomain, true);
      matchingKey = keys.find((k) => k.kid === header.kid);
    } catch {
      return accessError("access_keys_unavailable", 503);
    }
  }

  if (!matchingKey) {
    return accessError("access_denied", 403);
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
      return accessError("access_denied", 403);
    }
  } catch {
    return accessError("access_denied", 403);
  }

  const aud = payload?.aud;
  const hasAud = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (!hasAud) {
    return accessError("access_denied", 403);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload?.exp !== "number" || payload.exp <= now) {
    return accessError("access_denied", 403);
  }

  if (payload?.iss !== `https://${teamDomain}`) {
    return accessError("access_denied", 403);
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
        per_repository: [],
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
      }),
      { headers: READ_HEADERS }
    );
  }

  const repoRows = await env.DB.prepare(
    "SELECT DISTINCT repository FROM usage_records ORDER BY repository"
  ).all();
  const repositories = repoRows.results ? repoRows.results.map((r) => r.repository) : [];

  // One grouped query for the repos page's quiet-repository card and its Last
  // round column (#141, #142 finding 3944697641), instead of an unwindowed
  // page of every round the dashboard would otherwise have to walk.
  const perRepoRows = await env.DB.prepare(
    "SELECT repository, COUNT(*) as rounds, MAX(recorded_at) as last_recorded_at FROM usage_records GROUP BY repository ORDER BY repository"
  ).all();
  const per_repository = perRepoRows.results
    ? perRepoRows.results.map((r) => ({
        repository: r.repository,
        rounds: r.rounds,
        last_recorded_at: r.last_recorded_at,
      }))
    : [];

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

  // Did-not-run verdicts: a round with a mapped lane_events reason but no
  // usage_records row (the telemetry job never ran) has no verdict_kind of its
  // own until this query supplies one, in the same unwindowed scope as the
  // usage query above. The dedup that used to walk two unbounded result sets
  // in JS is now one aggregate query: a lane event whose run_id already has a
  // usage_records row is excluded by NOT EXISTS, usage_records still wins, and
  // a null run_id still counts (NOT EXISTS is true when the correlated
  // equality can never match) (#177, thread 4006669679).
  const mappedReasons = Object.keys(LANE_REASON_TO_VERDICT_KIND);
  if (mappedReasons.length > 0) {
    const placeholders = mappedReasons.map(() => "?").join(", ");
    const laneCountRows = await env.DB.prepare(
      `SELECT le.reason, COUNT(*) as cnt
       FROM lane_events le
       WHERE le.reason IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM usage_records ur WHERE ur.run_id = le.run_id)
       GROUP BY le.reason`
    ).bind(...mappedReasons).all();
    for (const r of laneCountRows.results ?? []) {
      const mapped = LANE_REASON_TO_VERDICT_KIND[r.reason];
      if (!mapped) continue;
      verdict_kinds[mapped] = (verdict_kinds[mapped] ?? 0) + r.cnt;
    }
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
      per_repository,
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
    "agents_status",
    "level",
    "level_source",
    "context_repositories",
    "context_lines",
    "failure_class",
    "failure_retryable",
    "failure_reset_at",
    "api_error_status",
    "credential_type",
    "base_pr_number",
    "patch_fingerprint",
  ];
  if (includeBlobs) {
    columns.push(
      "per_model_usage",
      "subagent_stats",
      "raw_result",
      "verdict_text",
      "comment_node_ids",
      "config_resolution",
      "config_effective"
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
    "reviewable_lines",
    "max_reviewable_lines",
    "actor",
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

async function handleRoundAgents(url, env) {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "missing session_id" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  let limit = 64;
  const limitParam = url.searchParams.get("limit");
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

  const query = `SELECT
    session_id,
    agent_id,
    subagent_type,
    spawn_depth,
    status,
    model,
    input_tokens,
    output_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    duration_ms,
    tool_uses,
    tool_uses_by_name,
    file_paths,
    tool_detail,
    harness_paths_count
  FROM round_agents
  WHERE session_id = ?
  ORDER BY agent_id ASC
  LIMIT ?`;

  const { results } = await env.DB.prepare(query).bind(sessionId, limit).all();
  const rows = results ?? [];

  return new Response(
    JSON.stringify({
      rows,
      next_cursor: null,
    }),
    { headers: READ_HEADERS }
  );
}

async function handlePrs(url, env) {
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

  const state = searchParams.get("state");
  if (state !== null) {
    conditions.push("state = ?");
    bindings.push(state);
  }

  const cursor = searchParams.get("cursor");
  if (cursor !== null) {
    const firstPipe = cursor.indexOf("|");
    if (firstPipe === -1) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    const lastPipe = cursor.lastIndexOf("|");
    if (firstPipe === lastPipe) {
      if (repository === null) {
        // Two-part cursor requires repository filter to be valid (#136, finding 3944010384).
        return new Response(JSON.stringify({ error: "invalid cursor" }), {
          status: 400,
          headers: READ_HEADERS,
        });
      }
      const cursorUpdatedAt = cursor.slice(0, firstPipe);
      const cursorPrNumber = cursor.slice(firstPipe + 1);
      if (!cursorUpdatedAt || !cursorPrNumber || !/^\d+$/.test(cursorPrNumber)) {
        return new Response(JSON.stringify({ error: "invalid cursor" }), {
          status: 400,
          headers: READ_HEADERS,
        });
      }
      conditions.push("(updated_at < ? OR (updated_at = ? AND pr_number < ?))");
      bindings.push(cursorUpdatedAt, cursorUpdatedAt, Number(cursorPrNumber));
    } else {
      const cursorUpdatedAt = cursor.slice(0, firstPipe);
      const cursorRepo = cursor.slice(firstPipe + 1, lastPipe);
      const cursorPrNumber = cursor.slice(lastPipe + 1);
      if (!cursorUpdatedAt || !cursorRepo || !cursorPrNumber || !/^\d+$/.test(cursorPrNumber)) {
        return new Response(JSON.stringify({ error: "invalid cursor" }), {
          status: 400,
          headers: READ_HEADERS,
        });
      }
      conditions.push("(updated_at < ? OR (updated_at = ? AND (repository < ? OR (repository = ? AND pr_number < ?))))");
      bindings.push(cursorUpdatedAt, cursorUpdatedAt, cursorRepo, cursorRepo, Number(cursorPrNumber));
    }
  }

  let query = `SELECT
    repository,
    pr_number,
    state,
    title,
    author,
    base_ref,
    head_ref,
    head_sha,
    merged_at,
    closed_at,
    updated_at,
    source,
    (SELECT COUNT(*) FROM review_findings f
      WHERE f.repository = prs.repository AND f.pr_number = prs.pr_number) AS total_findings,
    (SELECT COUNT(*) FROM review_findings f
      WHERE f.repository = prs.repository AND f.pr_number = prs.pr_number
        AND COALESCE(f.is_resolved, 0) = 0) AS open_findings
  FROM prs`;

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  query += ` ORDER BY updated_at DESC, repository DESC, pr_number DESC LIMIT ?`;
  bindings.push(limit);

  const { results } = await env.DB.prepare(query).bind(...bindings).all();
  const rows = results ?? [];
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? `${rows[rows.length - 1].updated_at}|${rows[rows.length - 1].repository}|${rows[rows.length - 1].pr_number}`
      : null;

  return new Response(
    JSON.stringify({
      rows,
      next_cursor: nextCursor,
    }),
    { headers: READ_HEADERS }
  );
}

// Programmatic read route for the telemetry reconciler (#87).
// Sits behind Cloudflare Access, so it stays on the bearer check alone: slice 9 (#176)
// shares queryAccountedRuns with the OIDC-capable ingest routes, not this route's auth (F7).
// Authenticates with REVIEW_TELEMETRY_TOKEN and returns distinct run_ids across
// both usage_records and lane_events in the requested window (capped at 30 days).
async function handleAccountedRuns(request, url, env) {
  const token = env?.REVIEW_TELEMETRY_TOKEN;
  const authHeader = request.headers.get("authorization");
  if (!token || !authHeader || !timingSafeEqual(authHeader, `Bearer ${token}`)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: READ_HEADERS,
    });
  }

  const repository = url.searchParams.get("repository");
  if (repository === null || repository === "") {
    return new Response(JSON.stringify({ error: "missing repository" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  const since = url.searchParams.get("since");
  if (since === null || since === "") {
    return new Response(JSON.stringify({ error: "missing since" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  const until = url.searchParams.get("until");
  if (until === null || until === "") {
    return new Response(JSON.stringify({ error: "missing until" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]00(?::?00)?)$/;
  if (!isoUtcPattern.test(since) || Number.isNaN(new Date(since).getTime())) {
    return new Response(JSON.stringify({ error: "invalid since" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  if (!isoUtcPattern.test(until) || Number.isNaN(new Date(until).getTime())) {
    return new Response(JSON.stringify({ error: "invalid until" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  const sinceDate = new Date(since);
  const untilDate = new Date(until);
  if (untilDate.getTime() < sinceDate.getTime()) {
    return new Response(JSON.stringify({ error: "invalid window: until precedes since" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  if (untilDate.getTime() - sinceDate.getTime() > MAX_WINDOW_MS) {
    return new Response(JSON.stringify({ error: "window exceeds 30 days" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  // Normalize timestamp bounds to canonical ISO string for text comparison in D1 (#87, finding 3944010386).
  const sinceIso = sinceDate.toISOString();
  const untilIso = untilDate.toISOString();

  let results;
  try {
    results = await queryAccountedRuns(env.DB, repository, sinceIso, untilIso);
  } catch {
    return new Response(JSON.stringify({ error: "database error" }), {
      status: 500,
      headers: READ_HEADERS,
    });
  }

  const runIds = Array.from(
    new Set(
      results
        .map((r) => Number(r.run_id))
        .filter((id) => Number.isInteger(id))
    )
  ).sort((a, b) => a - b);

  return new Response(
    JSON.stringify({
      repository,
      since,
      until,
      run_ids: runIds,
    }),
    { headers: READ_HEADERS }
  );
}

// Queries runs across usage_records and lane_events for reconciliation (#176).
// Health windows are HALF-OPEN, [since, until). The health caller splits an oversize
// run list into sub-windows that tile the caller's window, so an inclusive upper bound
// would count a row sitting exactly on a shared boundary in both neighbours. Half-open
// also makes consecutive health reports tile rather than overlap at their join.
// The timestamp format admits fractional seconds, so stepping a boundary back by an
// epsilon is not a safe alternative. Story: #177, thread 4006669665.
async function queryAccountedRuns(db, repository, sinceIso, untilIso) {
  const query = `SELECT run_id, 'usage_records' AS source_table FROM usage_records WHERE repository = ? AND recorded_at >= ? AND recorded_at < ? AND run_id IS NOT NULL
UNION ALL
SELECT run_id, 'lane_events' AS source_table FROM lane_events WHERE repository = ? AND recorded_at >= ? AND recorded_at < ? AND run_id IS NOT NULL
ORDER BY run_id ASC`;
  const res = await db.prepare(query).bind(repository, sinceIso, untilIso, repository, sinceIso, untilIso).all();
  return res?.results ?? [];
}

// Counts lane_events for a repository in a window, grouped by reason (#176).
async function queryLaneEventsByReason(db, repository, sinceIso, untilIso) {
  const res = await db
    .prepare(
      `SELECT reason, COUNT(*) AS count FROM lane_events WHERE repository = ? AND recorded_at >= ? AND recorded_at < ? GROUP BY reason`
    )
    .bind(repository, sinceIso, untilIso)
    .all();
  const byReason = {};
  for (const row of res?.results ?? []) {
    if (typeof row.reason === "string" && row.reason) {
      byReason[row.reason] = Number(row.count) || 0;
    }
  }
  return byReason;
}

// Counts review_findings swept for a repository in a window (#176).
async function queryFindingsSwept(db, repository, sinceIso, untilIso) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM review_findings WHERE repository = ? AND last_swept_at >= ? AND last_swept_at < ?`
    )
    .bind(repository, sinceIso, untilIso)
    .first();
  return Number(row?.count) || 0;
}

async function handleHealth(request, env, { getKey } = {}) {
  if (await isIngestRateLimited(request, env)) {
    return new Response(null, { status: 429 });
  }

  const auth = await authenticateIngest(request, env, { getKey });
  if (auth instanceof Response) {
    return auth;
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_INGEST_BYTES) {
    return new Response(null, { status: 413 });
  }

  const rawText = await readBoundedText(request, MAX_INGEST_BYTES);
  if (rawText === null) {
    return new Response(null, { status: 413 });
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return new Response(JSON.stringify({ error: "invalid payload" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (
    auth.method === "oidc" &&
    (typeof payload.repository !== "string" ||
      payload.repository.toLowerCase() !== auth.repository.toLowerCase())
  ) {
    return new Response(JSON.stringify({ error: "repository mismatch" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  if (typeof payload.repository !== "string" || !payload.repository.trim()) {
    return new Response(JSON.stringify({ error: "missing or invalid repository" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (payload.schema_version !== 1) {
    return new Response(JSON.stringify({ error: "missing or invalid schema_version" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]00(?::?00)?)$/;

  if (
    typeof payload.window_start !== "string" ||
    !isoUtcPattern.test(payload.window_start) ||
    Number.isNaN(new Date(payload.window_start).getTime())
  ) {
    return new Response(JSON.stringify({ error: "invalid window_start" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (
    typeof payload.window_end !== "string" ||
    !isoUtcPattern.test(payload.window_end) ||
    Number.isNaN(new Date(payload.window_end).getTime())
  ) {
    return new Response(JSON.stringify({ error: "invalid window_end" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const startDate = new Date(payload.window_start);
  const endDate = new Date(payload.window_end);
  if (endDate.getTime() < startDate.getTime()) {
    return new Response(JSON.stringify({ error: "invalid window: window_end precedes window_start" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (payload.share !== "full" && payload.share !== "off") {
    return new Response(JSON.stringify({ error: "missing or invalid share" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!Array.isArray(payload.runs) || payload.runs.length > 1000) {
    return new Response(JSON.stringify({ error: "missing or invalid runs" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Every run is validated up front; a sender cannot report its own missing_runs or
  // any other derived count, the Worker computes all of them from D1 below (#176).
  for (const run of payload.runs) {
    if (
      !run ||
      typeof run !== "object" ||
      !Number.isInteger(run.id) ||
      typeof run.conclusion !== "string" ||
      typeof run.created_at !== "string" ||
      !isoUtcPattern.test(run.created_at) ||
      Number.isNaN(new Date(run.created_at).getTime()) ||
      typeof run.event !== "string"
    ) {
      return new Response(JSON.stringify({ error: "invalid run entry" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const sinceIso = startDate.toISOString();
  const untilIso = endDate.toISOString();

  let accountedResults;
  let laneEventsByReason;
  let findingsSwept;
  try {
    accountedResults = await queryAccountedRuns(env.DB, payload.repository, sinceIso, untilIso);
    laneEventsByReason = await queryLaneEventsByReason(env.DB, payload.repository, sinceIso, untilIso);
    findingsSwept = await queryFindingsSwept(env.DB, payload.repository, sinceIso, untilIso);
  } catch {
    return new Response(JSON.stringify({ error: "database error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const accountedRunIds = new Set();
  for (const r of accountedResults) {
    const rid = Number(r.run_id);
    if (Number.isInteger(rid)) accountedRunIds.add(rid);
  }

  const unaccountedRuns = [];
  let startupFailures = 0;
  for (const run of payload.runs) {
    if (run.conclusion === "startup_failure") {
      startupFailures += 1;
    }
    if (!accountedRunIds.has(run.id)) {
      unaccountedRuns.push({ id: run.id, conclusion: run.conclusion, created_at: run.created_at });
    }
  }
  const runsAccounted = payload.runs.length - unaccountedRuns.length;

  const repositoryId = auth.method === "oidc" ? (auth.repository_id !== null ? Number(auth.repository_id) : null) : null;
  const unaccountedRunsJson = JSON.stringify(unaccountedRuns);
  const laneEventsByReasonJson = JSON.stringify(laneEventsByReason);

  let insertResult;
  try {
    insertResult = await env.DB.prepare(
      `INSERT INTO health_reports (
        repository,
        repository_id,
        window_start,
        window_end,
        runs_seen,
        runs_accounted,
        unaccounted_runs,
        startup_failures,
        lane_events_by_reason,
        findings_swept,
        share,
        ingest_auth
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    ).bind(
      truncateString(payload.repository, 512),
      repositoryId,
      truncateString(payload.window_start, 128),
      truncateString(payload.window_end, 128),
      payload.runs.length,
      runsAccounted,
      unaccountedRunsJson,
      startupFailures,
      laneEventsByReasonJson,
      findingsSwept,
      payload.share,
      auth.method
    ).run();
  } catch {
    return new Response(JSON.stringify({ error: "database error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      status: "ok",
      id: insertResult?.meta?.last_row_id ?? null,
      repository: payload.repository,
      window_start: payload.window_start,
      window_end: payload.window_end,
      share: payload.share,
      runs_seen: payload.runs.length,
      runs_accounted: runsAccounted,
      unaccounted_runs: unaccountedRuns,
      startup_failures: startupFailures,
      lane_events_by_reason: laneEventsByReason,
      findings_swept: findingsSwept,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

async function handleIngest(request, env, { getKey } = {}) {
  if (await isIngestRateLimited(request, env)) {
    return new Response(null, { status: 429 });
  }

  const auth = await authenticateIngest(request, env, { getKey });
  if (auth instanceof Response) {
    return auth;
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

    if (
      auth.method === "oidc" &&
      payload.repository.toLowerCase() !== auth.repository.toLowerCase()
    ) {
      return new Response(JSON.stringify({ error: "repository mismatch" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
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

    if (payload.agents !== undefined) {
      if (!Array.isArray(payload.agents)) {
        return new Response(JSON.stringify({ error: "invalid agents: must be an array" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      // Per-agent telemetry storage (#93): cap at 64 entries to bound batch size.
      if (payload.agents.length > 64) {
        return new Response(JSON.stringify({ error: "too many agents: max 64" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      for (let i = 0; i < payload.agents.length; i++) {
        const agent = payload.agents[i];
        if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
          return new Response(
            JSON.stringify({ error: `invalid agent at index ${i}: must be an object` }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            }
          );
        }

        if (typeof agent.agent_id !== "string" || agent.agent_id.trim().length === 0) {
          return new Response(
            JSON.stringify({ error: `invalid agent at index ${i}: missing or empty agent_id` }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            }
          );
        }

        // Half the primary key, so truncating it would silently merge two agents that
        // differ only past the limit. Reject instead. Story: #93.
        if (agent.agent_id.length > AGENT_ID_MAX_LENGTH) {
          return new Response(
            JSON.stringify({
              error: `invalid agent at index ${i}: agent_id exceeds ${AGENT_ID_MAX_LENGTH} characters`,
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            }
          );
        }

        // #174, CR #173 thread 4000816218: neither field was validated, so a
        // malformed tool_detail (a non-object, or a string that fails to parse)
        // or a negative harness_paths_count stored anyway, silently as-is or
        // as null, while the caller still received 204.
        if (!isValidJsonShape(agent.tool_detail, "object")) {
          return new Response(
            JSON.stringify({ error: `invalid agent at index ${i}: tool_detail must be a JSON object` }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        if (
          agent.harness_paths_count !== undefined &&
          agent.harness_paths_count !== null &&
          !(Number.isInteger(agent.harness_paths_count) && agent.harness_paths_count >= 0)
        ) {
          return new Response(
            JSON.stringify({
              error: `invalid agent at index ${i}: harness_paths_count must be a non-negative integer`,
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
      }
    }

    // Computed here, not in the workflow, so it cannot drift between callers pinned at
    // @main: one implementation. Story: #47 amendment.
    const variantKey = await computeVariantKey(
      payload.prompt_hash ?? null,
      payload.model ?? null,
      payload.action_version ?? null,
      payload.config_hash ?? null,
      payload.round_type ?? null
    );

    // Name columns literally so unmapped payload fields are dropped (#41).
    // Protect against retried POST requests without re-running (#41).
    try {
      const usageStmt = env.DB.prepare(
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
          pr_head_ref,
          prompt_hash,
          action_version,
          config_hash,
          variant,
          variant_key,
          agents_status,
          reviewable_lines,
          size_override,
          config_effective,
          level,
          level_source,
          context_repositories,
          context_lines,
          failure_class,
          failure_retryable,
          failure_reset_at,
          api_error_status,
          credential_type,
          base_pr_number,
          patch_fingerprint,
          ingest_auth,
          repository_id
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
          ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
          ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40,
          ?41, ?42, ?43, ?44, ?45, ?46, ?47, ?48, ?49, ?50,
          ?51, ?52, ?53, ?54, ?55, ?56, ?57, ?58, ?59, ?60, ?61, ?62, ?63,
          ?64, ?65
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
        truncateString(payload.pr_head_ref, 512),
        payload.prompt_hash ?? null,
        payload.action_version ?? null,
        payload.config_hash ?? null,
        payload.variant ?? null,
        variantKey,
        payload.agents_status ?? null,
        payload.reviewable_lines ?? null,
        payload.size_override ?? null,
        serializeJson(payload.config_effective, null),
        payload.level ?? null,
        payload.level_source ?? null,
        payload.context_repositories ?? null,
        payload.context_lines ?? null,
        payload.failure_class ?? null,
        payload.failure_retryable ?? null,
        payload.failure_reset_at ?? null,
        payload.api_error_status ?? null,
        payload.credential_type ?? null,
        payload.base_pr_number ?? null,
        payload.patch_fingerprint ?? null,
        auth.method,
        auth.method === "oidc" ? (auth.repository_id !== null ? Number(auth.repository_id) : null) : null
      );

      const agentStmts = [];
      if (Array.isArray(payload.agents) && payload.agents.length > 0) {
        for (const agent of payload.agents) {
          const stmt = env.DB.prepare(
            `INSERT INTO round_agents (
              session_id,
              agent_id,
              subagent_type,
              spawn_depth,
              status,
              model,
              input_tokens,
              output_tokens,
              cache_read_input_tokens,
              cache_creation_input_tokens,
              duration_ms,
              tool_uses,
              tool_uses_by_name,
              file_paths,
              tool_detail,
              harness_paths_count
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
              ?11, ?12, ?13, ?14, ?15, ?16
            )
            ON CONFLICT(session_id, agent_id) DO UPDATE SET
              subagent_type = excluded.subagent_type,
              spawn_depth = excluded.spawn_depth,
              status = excluded.status,
              model = excluded.model,
              input_tokens = excluded.input_tokens,
              output_tokens = excluded.output_tokens,
              cache_read_input_tokens = excluded.cache_read_input_tokens,
              cache_creation_input_tokens = excluded.cache_creation_input_tokens,
              duration_ms = excluded.duration_ms,
              tool_uses = excluded.tool_uses,
              tool_uses_by_name = excluded.tool_uses_by_name,
              file_paths = excluded.file_paths,
              tool_detail = excluded.tool_detail,
              harness_paths_count = excluded.harness_paths_count`
          ).bind(
            payload.session_id,
            agent.agent_id,
            truncateString(agent.subagent_type, 512),
            toIntegerOrNull(agent.spawn_depth),
            truncateString(agent.status, 512),
            truncateString(agent.model, 512),
            toIntegerOrNull(agent.input_tokens),
            toIntegerOrNull(agent.output_tokens),
            toIntegerOrNull(agent.cache_read_input_tokens),
            toIntegerOrNull(agent.cache_creation_input_tokens),
            toIntegerOrNull(agent.duration_ms),
            toIntegerOrNull(agent.tool_uses),
            serializeJson(agent.tool_uses_by_name, null),
            serializeJson(agent.file_paths, null),
            serializeJson(agent.tool_detail, null),
            toIntegerOrNull(agent.harness_paths_count)
          );
          agentStmts.push(stmt);
        }
      }

      // Single D1 batch guarantees a round is never recorded with a partial agent set (#93).
      if (agentStmts.length > 0) {
        await env.DB.batch([usageStmt, ...agentStmts]);
      } else {
        await usageStmt.run();
      }
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

    if (
      auth.method === "oidc" &&
      payload.repository.toLowerCase() !== auth.repository.toLowerCase()
    ) {
      return new Response(JSON.stringify({ error: "repository mismatch" }), {
        status: 403,
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
          lane_version,
          reviewable_lines,
          max_reviewable_lines,
          actor,
          ingest_auth,
          repository_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
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
        payload.lane_version ?? null,
        payload.reviewable_lines ?? null,
        payload.max_reviewable_lines ?? null,
        payload.actor ?? null,
        auth.method,
        auth.method === "oidc" ? (auth.repository_id !== null ? Number(auth.repository_id) : null) : null
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

async function handlePrState(request, env, { getKey } = {}) {
  if (await isIngestRateLimited(request, env)) {
    return new Response(null, { status: 429 });
  }

  const auth = await authenticateIngest(request, env, { getKey });
  if (auth instanceof Response) {
    return auth;
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

  if (typeof payload.repository !== "string" || payload.repository.trim().length === 0) {
    return new Response(JSON.stringify({ error: "missing or invalid repository" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (
    auth.method === "oidc" &&
    payload.repository.toLowerCase() !== auth.repository.toLowerCase()
  ) {
    return new Response(JSON.stringify({ error: "repository mismatch" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  if (typeof payload.pr_number !== "number" || !Number.isInteger(payload.pr_number)) {
    return new Response(JSON.stringify({ error: "missing or invalid pr_number" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (typeof payload.source !== "string" || !VALID_PR_SOURCES.has(payload.source)) {
    return new Response(JSON.stringify({ error: "invalid source" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (payload.state !== undefined) {
    if (typeof payload.state !== "string" || !VALID_PR_STATES.has(payload.state)) {
      return new Response(JSON.stringify({ error: "invalid state" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }

  for (const field of PR_STRING_FIELDS) {
    const val = payload[field];
    if (val !== undefined && val !== null && typeof val !== "string") {
      return new Response(JSON.stringify({ error: "invalid field types" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // Stale-write protection keys on when event occurred, not Worker receipt time (#136, finding 3944010389).
  let updatedAt;
  if (payload.updated_at !== undefined && payload.updated_at !== null) {
    if (typeof payload.updated_at !== "string" || Number.isNaN(new Date(payload.updated_at).getTime())) {
      return new Response(JSON.stringify({ error: "invalid updated_at" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    updatedAt = new Date(payload.updated_at).toISOString();
  } else {
    updatedAt = new Date().toISOString();
  }

  try {
    const existing = await env.DB.prepare(
      "SELECT updated_at FROM prs WHERE repository = ? AND pr_number = ?"
    ).bind(payload.repository, payload.pr_number).first();

    if (existing && existing.updated_at && existing.updated_at > updatedAt) {
      return new Response(null, { status: 204 });
    }

    await env.DB.prepare(
      `INSERT INTO prs (
        repository,
        pr_number,
        state,
        title,
        author,
        base_ref,
        head_ref,
        head_sha,
        merged_at,
        closed_at,
        updated_at,
        source,
        ingest_auth,
        repository_id
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(repository, pr_number) DO UPDATE SET
        state = COALESCE(excluded.state, prs.state),
        title = COALESCE(excluded.title, prs.title),
        author = COALESCE(excluded.author, prs.author),
        base_ref = COALESCE(excluded.base_ref, prs.base_ref),
        head_ref = COALESCE(excluded.head_ref, prs.head_ref),
        head_sha = COALESCE(excluded.head_sha, prs.head_sha),
        merged_at = COALESCE(excluded.merged_at, prs.merged_at),
        closed_at = COALESCE(excluded.closed_at, prs.closed_at),
        updated_at = excluded.updated_at,
        source = excluded.source,
        ingest_auth = excluded.ingest_auth,
        repository_id = COALESCE(excluded.repository_id, prs.repository_id)
      WHERE excluded.updated_at >= prs.updated_at`
    ).bind(
      truncateString(payload.repository, 512),
      payload.pr_number,
      payload.state ?? null,
      truncateString(payload.title, 512),
      truncateString(payload.author, 512),
      truncateString(payload.base_ref, 512),
      truncateString(payload.head_ref, 512),
      truncateString(payload.head_sha, 512),
      truncateString(payload.merged_at, 512),
      truncateString(payload.closed_at, 512),
      updatedAt,
      payload.source,
      auth.method,
      auth.method === "oidc" ? (auth.repository_id !== null ? Number(auth.repository_id) : null) : null
    ).run();
  } catch {
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 204 });
}

// One finding's shape check. Returns an error string, or null when the finding is well-formed.
// Fields outside FINDING_STRING_FIELDS / FINDING_INTEGER_FIELDS are read nowhere below, which is
// how an unrecognised field (a severity, a lane) is ignored rather than stored (#47).
function validateFinding(finding) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return "finding is not an object";
  }

  for (const field of FINDING_STRING_FIELDS) {
    const val = finding[field];
    const nullable = FINDING_NULLABLE_STRING_FIELDS.has(field);
    if (val === undefined || val === null) {
      if (!nullable) {
        return `missing ${field}`;
      }
      continue;
    }
    if (typeof val !== "string") {
      return `invalid ${field}`;
    }
  }

  for (const field of FINDING_INTEGER_FIELDS) {
    const val = finding[field];
    const nullable = FINDING_NULLABLE_INTEGER_FIELDS.has(field);
    if (val === undefined || val === null) {
      if (!nullable) {
        return `missing ${field}`;
      }
      continue;
    }
    if (typeof val !== "number" || !Number.isInteger(val)) {
      return `invalid ${field}`;
    }
  }

  if (finding.thread_node_id.trim().length === 0) {
    return "empty thread_node_id";
  }

  if (finding.fix_sha_source != null && !VALID_FIX_SHA_SOURCES.has(finding.fix_sha_source)) {
    return "invalid fix_sha_source";
  }

  if (finding.verify_verdict != null && !VALID_VERIFY_VERDICTS.has(finding.verify_verdict)) {
    return "invalid verify_verdict";
  }

  return null;
}

async function handleIngestFindings(request, env, { getKey } = {}) {
  if (await isIngestRateLimited(request, env)) {
    return new Response(null, { status: 429 });
  }

  const auth = await authenticateIngest(request, env, { getKey });
  if (auth instanceof Response) {
    return auth;
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

  if (!Array.isArray(payload.findings)) {
    return new Response(JSON.stringify({ error: "missing or invalid findings array" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (auth.method === "oidc") {
    // Every row's repository must be a string equal to the claim's (F5, #176), checked
    // before validateFinding so a mismatched or non-string repository under OIDC is a
    // 403, not a 400 that leans on validateFinding's own typing to hold the invariant.
    const mismatch = payload.findings.some((f) => {
      const repo = f && typeof f === "object" && !Array.isArray(f) ? f.repository : undefined;
      return typeof repo !== "string" || repo.toLowerCase() !== auth.repository.toLowerCase();
    });
    if (mismatch) {
      return new Response(JSON.stringify({ error: "repository mismatch" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
  }

  for (const finding of payload.findings) {
    const error = validateFinding(finding);
    if (error) {
      return new Response(JSON.stringify({ error }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }

  if (payload.findings.length === 0) {
    return new Response(null, { status: 204 });
  }

  const stmt = env.DB.prepare(
    `INSERT INTO review_findings (
      thread_node_id,
      repository,
      pr_number,
      path,
      original_line,
      line,
      is_resolved,
      is_outdated,
      resolved_by_login,
      thread_created_at,
      header_raw,
      body_excerpt,
      diff_hunk,
      human_reply_count,
      human_reply_sha,
      fix_sha,
      fix_sha_source,
      verify_verdict,
      head_sha_reviewed,
      last_swept_at,
      row_set_incomplete,
      ingest_auth,
      repository_id
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
    -- A thread is mutable state, not an immutable event (#47): every column is overwritten
    -- from the latest sweep pass rather than only filled in when currently null, so a newly
    -- resolved thread or an edited comment settles here on the very next sweep.
    ON CONFLICT(thread_node_id) DO UPDATE SET
      repository = excluded.repository,
      pr_number = excluded.pr_number,
      path = excluded.path,
      original_line = excluded.original_line,
      line = excluded.line,
      is_resolved = excluded.is_resolved,
      is_outdated = excluded.is_outdated,
      resolved_by_login = excluded.resolved_by_login,
      thread_created_at = excluded.thread_created_at,
      header_raw = excluded.header_raw,
      body_excerpt = excluded.body_excerpt,
      diff_hunk = excluded.diff_hunk,
      human_reply_count = excluded.human_reply_count,
      human_reply_sha = excluded.human_reply_sha,
      fix_sha = excluded.fix_sha,
      fix_sha_source = excluded.fix_sha_source,
      verify_verdict = excluded.verify_verdict,
      head_sha_reviewed = excluded.head_sha_reviewed,
      last_swept_at = excluded.last_swept_at,
      row_set_incomplete = excluded.row_set_incomplete,
      ingest_auth = excluded.ingest_auth,
      repository_id = COALESCE(excluded.repository_id, review_findings.repository_id)`
  );

  const stmts = payload.findings.map((finding) =>
    stmt.bind(
      finding.thread_node_id,
      truncateString(finding.repository, 512),
      finding.pr_number,
      truncateString(finding.path, 1024),
      finding.original_line ?? null,
      finding.line ?? null,
      finding.is_resolved,
      finding.is_outdated,
      truncateString(finding.resolved_by_login, 512),
      truncateString(finding.thread_created_at, 512),
      truncateString(finding.header_raw, 1024),
      truncateString(finding.body_excerpt, 8192),
      truncateString(finding.diff_hunk, 8192),
      finding.human_reply_count,
      truncateString(finding.human_reply_sha, 128),
      truncateString(finding.fix_sha, 128),
      finding.fix_sha_source ?? null,
      finding.verify_verdict ?? null,
      truncateString(finding.head_sha_reviewed, 128),
      truncateString(finding.last_swept_at, 512),
      finding.row_set_incomplete,
      auth.method,
      auth.method === "oidc" ? (auth.repository_id !== null ? Number(auth.repository_id) : null) : null
    )
  );

  try {
    await env.DB.batch(stmts);
  } catch {
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 204 });
}

// Read route for review_findings (#111, #75). Same shape as handleLaneEvents/handlePrs:
// explicit column list, cursor pagination, verifyAccess auth applied by the caller. Newest
// first by thread_created_at, so a findings inbox and a PR-scoped panel are the same query
// with an added pr_number filter, per #111's table contract (up to 1000 rows, no page walking).
async function handleFindings(url, env) {
  const searchParams = url.searchParams;
  let limit = 1000;
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

  const prNumberParam = searchParams.get("pr_number");
  if (prNumberParam !== null) {
    if (!/^[1-9]\d*$/.test(prNumberParam)) {
      return new Response(JSON.stringify({ error: "invalid pr_number" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    conditions.push("pr_number = ?");
    bindings.push(Number(prNumberParam));
  }

  const cursor = searchParams.get("cursor");
  if (cursor !== null) {
    const pipeIndex = cursor.lastIndexOf("|");
    if (pipeIndex === -1) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    const cursorCreatedAt = cursor.slice(0, pipeIndex);
    const cursorThreadNodeId = cursor.slice(pipeIndex + 1);
    if (!cursorCreatedAt || !cursorThreadNodeId) {
      return new Response(JSON.stringify({ error: "invalid cursor" }), {
        status: 400,
        headers: READ_HEADERS,
      });
    }
    conditions.push("(thread_created_at < ? OR (thread_created_at = ? AND thread_node_id < ?))");
    bindings.push(cursorCreatedAt, cursorCreatedAt, cursorThreadNodeId);
  }

  const columns = [
    "thread_node_id",
    "repository",
    "pr_number",
    "path",
    "original_line",
    "line",
    "is_resolved",
    "is_outdated",
    "resolved_by_login",
    "thread_created_at",
    "header_raw",
    "body_excerpt",
    "diff_hunk",
    "human_reply_count",
    "human_reply_sha",
    "fix_sha",
    "fix_sha_source",
    "verify_verdict",
    "head_sha_reviewed",
    "last_swept_at",
    "row_set_incomplete",
  ];

  let query = `SELECT
    ${columns.join(",\n    ")}
  FROM review_findings`;

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  query += ` ORDER BY thread_created_at DESC, thread_node_id DESC LIMIT ?`;
  bindings.push(limit);

  const { results } = await env.DB.prepare(query).bind(...bindings).all();
  const rows = results ?? [];
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? `${rows[rows.length - 1].thread_created_at}|${rows[rows.length - 1].thread_node_id}`
      : null;

  return new Response(
    JSON.stringify({
      rows,
      next_cursor: nextCursor,
    }),
    { headers: READ_HEADERS }
  );
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

// Fleet routes return aggregates keyed by repository and identifiers, never a
// name, a title or a body: the text columns stay out of every fleet handler's
// SQL, pinned by tests/test-fleet-wall.py (#185).
const FLEET_CONFIG_LAYERS = Object.freeze(["repo_config", "org_defaults", "workflow_inputs"]);

async function handleFleetRepos(url, env) {
  const range = url.searchParams.get("range");
  if (range !== "rolling" && range !== "30d" && range !== "90d" && range !== "all") {
    return new Response(JSON.stringify({ error: "invalid range" }), {
      status: 400,
      headers: READ_HEADERS,
    });
  }

  const db = env.DB;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    // The rolling rule mirrors applyRange in dashboard/src/honesty/range.ts: the
    // last 50 rounds or the last 7 days, whichever holds more.
    let since = null;
    let label = "all recorded rounds";
    if (range === "30d" || range === "90d") {
      const days = range === "30d" ? 30 : 90;
      since = new Date(now - days * DAY_MS).toISOString();
      label = `the last ${days} days`;
    } else if (range === "rolling") {
      const c7 = new Date(now - 7 * DAY_MS).toISOString();
      const r50 = await db
        .prepare(
          "SELECT recorded_at FROM usage_records ORDER BY recorded_at DESC, session_id DESC LIMIT 1 OFFSET 49"
        )
        .first();
      const sevenDay = await db
        .prepare("SELECT COUNT(*) AS cnt FROM usage_records WHERE recorded_at >= ?")
        .bind(c7)
        .first();
      const inSevenDays = sevenDay?.cnt ?? 0;
      if (r50?.recorded_at) {
        if (inSevenDays >= 50) {
          since = c7;
          label = "the last 7 days";
        } else {
          since = r50.recorded_at;
          label = "the last 50 rounds";
        }
      } else {
        // Fewer than 50 rounds exist, so the 50-round side is every round. It
        // wins unless the 7 days hold them all, as in applyRange.
        const all = await db.prepare("SELECT COUNT(*) AS total FROM usage_records").first();
        if (inSevenDays >= (all?.total ?? 0)) {
          since = c7;
          label = "the last 7 days";
        } else {
          label = "the last 50 rounds";
        }
      }
    }

    const where = since === null ? "" : "WHERE recorded_at >= ?";
    const and = since === null ? "" : "recorded_at >= ? AND";
    const windowed = (sql) => {
      const stmt = db.prepare(sql);
      return since === null ? stmt : stmt.bind(since);
    };

    const everPosted = await db
      .prepare(
        "SELECT repository, MAX(recorded_at) AS last_recorded_at FROM usage_records GROUP BY repository ORDER BY repository"
      )
      .all();
    const counts = await windowed(
      `SELECT repository, COUNT(*) AS rounds, SUM(COALESCE(permission_denials, 0)) AS denials FROM usage_records ${where} GROUP BY repository`
    ).all();
    const lastRounds = await windowed(
      `SELECT repository, session_id, recorded_at, round_type, verdict_kind FROM (SELECT repository, session_id, recorded_at, round_type, verdict_kind, ROW_NUMBER() OVER (PARTITION BY repository ORDER BY recorded_at DESC, session_id DESC) AS rn FROM usage_records ${where}) WHERE rn = 1`
    ).all();

    const malformedByLayer = [];
    for (const layer of FLEET_CONFIG_LAYERS) {
      const rows = await windowed(
        `SELECT repository, json_extract(config_resolution, '$.layers.${layer}.outcome') AS outcome FROM (SELECT repository, config_resolution, ROW_NUMBER() OVER (PARTITION BY repository ORDER BY recorded_at DESC, session_id DESC) AS rn FROM usage_records WHERE ${and} config_resolution IS NOT NULL AND json_valid(config_resolution) AND json_type(config_resolution, '$.layers.${layer}') IS NOT NULL) WHERE rn = 1 AND outcome IN ('unparseable', 'schema-rejected')`
      ).all();
      malformedByLayer.push({ layer, rows: rows.results ?? [] });
    }

    const lastRecordedByRepo = new Map(
      (everPosted.results ?? []).map((r) => [r.repository, r.last_recorded_at])
    );
    const countsByRepo = new Map((counts.results ?? []).map((r) => [r.repository, r]));
    const lastRoundByRepo = new Map((lastRounds.results ?? []).map((r) => [r.repository, r]));
    const names = [...new Set([...lastRecordedByRepo.keys(), ...countsByRepo.keys()])].sort();

    const repositories = names.map((repository) => {
      const count = countsByRepo.get(repository);
      const last = lastRoundByRepo.get(repository);
      return {
        repository,
        rounds: count?.rounds ?? 0,
        denials: count?.denials ?? 0,
        last_round: last
          ? {
              session_id: last.session_id,
              recorded_at: last.recorded_at,
              round_type: last.round_type ?? null,
              verdict_kind: last.verdict_kind ?? null,
            }
          : null,
        last_recorded_at: lastRecordedByRepo.get(repository) ?? null,
      };
    });

    const malformed_configs = malformedByLayer
      .flatMap(({ layer, rows }, order) =>
        rows.map((r) => ({ repository: r.repository, layer, order }))
      )
      .sort((a, b) =>
        a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : a.order - b.order
      )
      .map(({ repository, layer }) => ({ repository, layer }));

    return new Response(
      JSON.stringify({
        window: { range, since, label },
        rounds: repositories.reduce((sum, r) => sum + r.rounds, 0),
        repositories,
        malformed_configs,
      }),
      { headers: READ_HEADERS }
    );
  } catch {
    return new Response(JSON.stringify({ error: "query failed" }), {
      status: 500,
      headers: READ_HEADERS,
    });
  }
}

export default {
  async fetch(request, env, ctx, options = {}) {
    const opts = (ctx && typeof ctx === "object" && typeof ctx.getKey === "function") ? ctx : (options || {});
    const getKey = opts.getKey || env?.getKey;
    const authOptions = getKey ? { getKey } : {};

    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (method === "POST" && (pathname === "/ingest" || pathname === "/")) {
      return handleIngest(request, env, authOptions);
    }

    if (method === "POST" && pathname === "/ingest/health") {
      return handleHealth(request, env, authOptions);
    }

    if (method === "POST" && pathname === "/pr-state") {
      return handlePrState(request, env, authOptions);
    }

    if (method === "POST" && pathname === "/ingest/findings") {
      return handleIngestFindings(request, env, authOptions);
    }

    if (
      method === "GET" &&
      (pathname === "/api/accounted-runs" ||
        pathname === "/api/accounted-runs/" ||
        pathname === "/ingest/accounted-runs" ||
        pathname === "/ingest/accounted-runs/")
    ) {
      return handleAccountedRuns(request, url, env);
    }

    if (
      method === "GET" &&
      (pathname === "/api/summary" ||
        pathname === "/api/runs" ||
        pathname === "/api/lane-events" ||
        pathname === "/api/round-agents" ||
        pathname === "/api/prs" ||
        pathname === "/api/findings")
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
      if (pathname === "/api/round-agents") {
        return handleRoundAgents(url, env);
      }
      if (pathname === "/api/prs") {
        return handlePrs(url, env);
      }
      if (pathname === "/api/findings") {
        return handleFindings(url, env);
      }
    }

    if (method === "GET" && pathname === "/api/fleet/repos") {
      const authError = await verifyAccess(request, env);
      if (authError) {
        return authError;
      }
      return handleFleetRepos(url, env);
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
