import type {
  ChangeRow,
  ChangesResponse,
  LaneEventRow,
  LaneEventsResponse,
  PrRow,
  PrsResponse,
  RoundAgentRow,
  RoundAgentsResponse,
  RoundRow,
  RunsResponse,
  SummaryResponse,
} from "./types";

/**
 * Access sends an HTML login redirect rather than a 401 when the session is gone,
 * so a non-JSON body on a GET is the signal to send the operator back to the IdP.
 * 503 joins 401/403 here too: verifyAccess (worker/index.js) answers "not
 * configured" or "signing keys unavailable" with 503, and both need the same
 * recovery affordance as a denied JWT. Story: #96.
 */
export type ApiErrorKind = "unauthenticated" | "http" | "network" | "malformed";

export class ApiError extends Error {
  status: number;
  kind: ApiErrorKind;
  /** The Worker's machine-readable `error` body field, when one was sent. */
  code?: string;

  constructor(message: string, status: number, kind: ApiErrorKind, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.code = code;
  }
}

export interface RunsQuery {
  limit?: number;
  repository?: string;
  round_type?: string;
  since?: string;
  until?: string;
  cursor?: string;
  include?: "blobs";
}

export interface LaneEventsQuery {
  limit?: number;
  repository?: string;
  since?: string;
  until?: string;
  cursor?: string;
}

export interface ChangesQuery {
  limit?: number;
  cursor?: string;
}

export interface PrsQuery {
  limit?: number;
  repository?: string;
  state?: string;
  cursor?: string;
}

/** The Worker caps limit at 1000, and at 50 once include=blobs is set. */
export const MAX_LIMIT = 1000;
export const MAX_LIMIT_WITH_BLOBS = 50;

export function runsUrl(query: RunsQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `/api/runs?${qs}` : "/api/runs";
}

export function laneEventsUrl(query: LaneEventsQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `/api/lane-events?${qs}` : "/api/lane-events";
}

export function changesUrl(query: ChangesQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `/api/changes?${qs}` : "/api/changes";
}

export function prsUrl(query: PrsQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `/api/prs?${qs}` : "/api/prs";
}

export function roundAgentsUrl(sessionId: string): string {
  const params = new URLSearchParams({ session_id: sessionId });
  return `/api/round-agents?${params.toString()}`;
}

async function getJson<T>(path: string, validate: (value: unknown) => value is T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      // Access answers an expired session with a cross-origin 302 to the IdP.
      // Following it fails CORS and surfaces as an indistinguishable TypeError,
      // so the redirect is caught here instead and named for what it is.
      redirect: "manual",
    });
  } catch (cause) {
    throw new ApiError(`could not reach the telemetry Worker: ${String(cause)}`, 0, "network");
  }

  if (res.type === "opaqueredirect" || res.status === 0) {
    throw new ApiError(
      "the Worker redirected this request, which is what Cloudflare Access does when the session has expired",
      res.status,
      "unauthenticated",
    );
  }

  // Status is read before content-type, or a 404 or an edge 502 with an HTML body
  // would tell the operator to sign in again. 503 is included because verifyAccess
  // answers with it when it could not even run the check (#96), not just when it
  // denied one; both are auth-recovery states from the UI's point of view.
  if (res.status === 401 || res.status === 403 || res.status === 503) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      code = body?.error;
    } catch {
      code = undefined;
    }
    throw new ApiError(
      code ? `Cloudflare Access refused this request: ${code}` : "Cloudflare Access refused this request",
      res.status,
      "unauthenticated",
      code,
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ? `: ${body.error}` : "";
    } catch {
      detail = "";
    }
    throw new ApiError(`GET ${path} returned ${res.status}${detail}`, res.status, "http");
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(
      "the Worker answered 200 with a non-JSON body, which is the Access login page",
      res.status,
      "unauthenticated",
    );
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new ApiError(`GET ${path} returned a body that is not valid JSON`, res.status, "malformed");
  }

  // A 200 of the wrong shape would otherwise reach lookupRound and throw a bare
  // TypeError off response.rows, losing the ApiError classification the UI reads.
  if (!validate(parsed)) {
    throw new ApiError(
      `GET ${path} returned JSON that is not the shape this route documents`,
      res.status,
      "malformed",
    );
  }
  return parsed;
}

export const REQUIRED_ROUND_KEYS = [
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
] as const;

export function isRoundRow(row: unknown): row is RoundRow {
  if (!row || typeof row !== "object") return false;
  return REQUIRED_ROUND_KEYS.every((key) => key in (row as Record<string, unknown>));
}

export function isRunsResponse(value: unknown): value is RunsResponse {
  if (!value || typeof value !== "object") return false;
  const { rows, next_cursor } = value as { rows?: unknown; next_cursor?: unknown };
  return (
    Array.isArray(rows) &&
    rows.every(isRoundRow) &&
    (next_cursor === null || next_cursor === undefined || typeof next_cursor === "string")
  );
}

export const REQUIRED_SUMMARY_KEYS = [
  "rows",
  "repositories",
  "per_repository",
  "wall_clock_ms",
  "denials_per_run",
  "cache_hit_rate",
  "caching_multiplier",
  "total_cost_usd",
  "first_recorded_at",
  "last_recorded_at",
  "verdict_kinds",
  "fallback_reasons",
  "model_sources",
  "canary_last_seen_at",
] as const;

function isPerRepositorySummary(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.repository === "string" &&
    typeof r.rounds === "number" &&
    (r.last_recorded_at === null || typeof r.last_recorded_at === "string")
  );
}

export function isSummaryResponse(value: unknown): value is SummaryResponse {
  if (!value || typeof value !== "object") return false;
  const val = value as Record<string, unknown>;
  if (!REQUIRED_SUMMARY_KEYS.every((key) => key in val)) return false;
  return (
    typeof val.rows === "number" &&
    Array.isArray(val.repositories) &&
    Array.isArray(val.per_repository) &&
    val.per_repository.every(isPerRepositorySummary) &&
    typeof val.verdict_kinds === "object" &&
    val.verdict_kinds !== null &&
    !Array.isArray(val.verdict_kinds) &&
    typeof val.fallback_reasons === "object" &&
    val.fallback_reasons !== null &&
    !Array.isArray(val.fallback_reasons) &&
    typeof val.model_sources === "object" &&
    val.model_sources !== null &&
    !Array.isArray(val.model_sources) &&
    (val.canary_last_seen_at === null || typeof val.canary_last_seen_at === "string")
  );
}

export const REQUIRED_LANE_EVENT_KEYS = [
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
] as const;

export function isLaneEventRow(row: unknown): row is LaneEventRow {
  if (!row || typeof row !== "object") return false;
  return REQUIRED_LANE_EVENT_KEYS.every((key) => key in (row as Record<string, unknown>));
}

export function isLaneEventsResponse(value: unknown): value is LaneEventsResponse {
  if (!value || typeof value !== "object") return false;
  const { rows, next_cursor } = value as { rows?: unknown; next_cursor?: unknown };
  return (
    Array.isArray(rows) &&
    rows.every(isLaneEventRow) &&
    (next_cursor === null || next_cursor === undefined || typeof next_cursor === "string")
  );
}

export const REQUIRED_CHANGE_KEYS = [
  "id",
  "name",
  "at",
  "source_url",
  "scope",
  "repository",
  "created_at",
] as const;

export function isChangeRow(row: unknown): row is ChangeRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    REQUIRED_CHANGE_KEYS.every((key) => key in r) &&
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.at === "string" &&
    (r.source_url === null || typeof r.source_url === "string") &&
    (r.scope === "repo" || r.scope === "fleet") &&
    (r.repository === null || typeof r.repository === "string") &&
    typeof r.created_at === "string"
  );
}

export function isChangesResponse(value: unknown): value is ChangesResponse {
  if (!value || typeof value !== "object") return false;
  const { rows, next_cursor } = value as { rows?: unknown; next_cursor?: unknown };
  return (
    Array.isArray(rows) &&
    rows.every(isChangeRow) &&
    (next_cursor === null || next_cursor === undefined || typeof next_cursor === "string")
  );
}

export const REQUIRED_ROUND_AGENT_KEYS = [
  "session_id",
  "agent_id",
  "subagent_type",
  "spawn_depth",
  "status",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "duration_ms",
  "tool_uses",
  "tool_uses_by_name",
  "file_paths",
] as const;

export function isRoundAgentRow(row: unknown): row is RoundAgentRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    REQUIRED_ROUND_AGENT_KEYS.every((key) => key in r) &&
    typeof r.session_id === "string" &&
    typeof r.agent_id === "string" &&
    (r.subagent_type === null || typeof r.subagent_type === "string") &&
    (r.spawn_depth === null || typeof r.spawn_depth === "number") &&
    (r.status === null || typeof r.status === "string") &&
    (r.model === null || typeof r.model === "string") &&
    (r.input_tokens === null || typeof r.input_tokens === "number") &&
    (r.output_tokens === null || typeof r.output_tokens === "number") &&
    (r.cache_read_input_tokens === null || typeof r.cache_read_input_tokens === "number") &&
    (r.cache_creation_input_tokens === null || typeof r.cache_creation_input_tokens === "number") &&
    (r.duration_ms === null || typeof r.duration_ms === "number") &&
    (r.tool_uses === null || typeof r.tool_uses === "number") &&
    (r.tool_uses_by_name === null || typeof r.tool_uses_by_name === "string") &&
    (r.file_paths === null || typeof r.file_paths === "string")
  );
}

export function isRoundAgentsResponse(value: unknown): value is RoundAgentsResponse {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (!("rows" in r) || !("next_cursor" in r)) return false;
  const { rows, next_cursor } = r;
  return (
    Array.isArray(rows) &&
    rows.every(isRoundAgentRow) &&
    (next_cursor === null || typeof next_cursor === "string")
  );
}

export const REQUIRED_PR_KEYS = [
  "repository",
  "pr_number",
  "state",
  "title",
  "author",
  "base_ref",
  "head_ref",
  "head_sha",
  "merged_at",
  "closed_at",
  "updated_at",
  "source",
] as const;

export function isPrRow(row: unknown): row is PrRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    REQUIRED_PR_KEYS.every((key) => key in r) &&
    typeof r.repository === "string" &&
    typeof r.pr_number === "number" &&
    (r.state === null || typeof r.state === "string") &&
    (r.title === null || typeof r.title === "string") &&
    (r.author === null || typeof r.author === "string") &&
    (r.base_ref === null || typeof r.base_ref === "string") &&
    (r.head_ref === null || typeof r.head_ref === "string") &&
    (r.head_sha === null || typeof r.head_sha === "string") &&
    (r.merged_at === null || typeof r.merged_at === "string") &&
    (r.closed_at === null || typeof r.closed_at === "string") &&
    typeof r.updated_at === "string" &&
    typeof r.source === "string"
  );
}

export function isPrsResponse(value: unknown): value is PrsResponse {
  if (!value || typeof value !== "object") return false;
  const { rows, next_cursor } = value as { rows?: unknown; next_cursor?: unknown };
  return (
    Array.isArray(rows) &&
    rows.every(isPrRow) &&
    (next_cursor === null || next_cursor === undefined || typeof next_cursor === "string")
  );
}

export interface TelemetryApi {
  fetchRuns(query?: RunsQuery): Promise<RunsResponse>;
  fetchSummary(): Promise<SummaryResponse>;
  fetchLaneEvents(query?: LaneEventsQuery): Promise<LaneEventsResponse>;
  fetchChanges(query?: ChangesQuery): Promise<ChangesResponse>;
  fetchRoundAgents(sessionId: string): Promise<RoundAgentsResponse>;
  fetchPRs(query?: PrsQuery): Promise<PrsResponse>;
  /** Set only by the fixture table, so the UI can say the rounds are invented. */
  readonly fixtures?: boolean;
}

export const httpApi: TelemetryApi = {
  fetchRuns: (query = {}) => getJson(runsUrl(query), isRunsResponse),
  fetchSummary: () => getJson("/api/summary", isSummaryResponse),
  fetchLaneEvents: (query = {}) => getJson(laneEventsUrl(query), isLaneEventsResponse),
  fetchChanges: (query = {}) => getJson(changesUrl(query), isChangesResponse),
  fetchRoundAgents: (sessionId: string) =>
    getJson(roundAgentsUrl(sessionId), isRoundAgentsResponse),
  fetchPRs: (query = {}) => getJson(prsUrl(query), isPrsResponse),
};

/**
 * The blob columns only arrive with include=blobs, and there is no by-id read
 * route. `recordedAt` turns the lookup into one exact request, because since and
 * until are inclusive bounds on recorded_at. Without it we walk pages instead.
 */
export const ROUND_SCAN_PAGES = 10;

export type RoundLookup =
  | { found: true; row: RoundRow }
  | { found: false; reason: "not-in-scan-window"; scanned: number };

export async function lookupRound(
  api: TelemetryApi,
  sessionId: string,
  recordedAt?: string,
): Promise<RoundLookup> {
  if (recordedAt) {
    const exact = await api.fetchRuns({
      since: recordedAt,
      until: recordedAt,
      include: "blobs",
      limit: MAX_LIMIT_WITH_BLOBS,
    });
    const hit = exact.rows.find((row) => row.session_id === sessionId);
    if (hit) {
      return { found: true, row: hit };
    }
  }

  let cursor: string | undefined;
  let scanned = 0;
  for (let page = 0; page < ROUND_SCAN_PAGES; page++) {
    const response = await api.fetchRuns({
      include: "blobs",
      limit: MAX_LIMIT_WITH_BLOBS,
      cursor,
    });
    scanned += response.rows.length;
    const hit = response.rows.find((row) => row.session_id === sessionId);
    if (hit) {
      return { found: true, row: hit };
    }
    if (!response.next_cursor) {
      break;
    }
    cursor = response.next_cursor;
  }
  return { found: false, reason: "not-in-scan-window", scanned };
}
