import type { LaneEventRow, LaneEventsResponse, RoundRow, RunsResponse, SummaryResponse } from "./types";

/**
 * Access sends an HTML login redirect rather than a 401 when the session is gone,
 * so a non-JSON body on a GET is the signal to send the operator back to the IdP.
 */
export type ApiErrorKind = "unauthenticated" | "http" | "network" | "malformed";

export class ApiError extends Error {
  status: number;
  kind: ApiErrorKind;

  constructor(message: string, status: number, kind: ApiErrorKind) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
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
  // would tell the operator to sign in again.
  if (res.status === 401 || res.status === 403) {
    throw new ApiError("Cloudflare Access refused this request", res.status, "unauthenticated");
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

export function isSummaryResponse(value: unknown): value is SummaryResponse {
  if (!value || typeof value !== "object") return false;
  const val = value as Record<string, unknown>;
  if (!REQUIRED_SUMMARY_KEYS.every((key) => key in val)) return false;
  return (
    typeof val.rows === "number" &&
    Array.isArray(val.repositories) &&
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

export interface TelemetryApi {
  fetchRuns(query?: RunsQuery): Promise<RunsResponse>;
  fetchSummary(): Promise<SummaryResponse>;
  fetchLaneEvents(query?: LaneEventsQuery): Promise<LaneEventsResponse>;
  /** Set only by the fixture table, so the UI can say the rounds are invented. */
  readonly fixtures?: boolean;
}

export const httpApi: TelemetryApi = {
  fetchRuns: (query = {}) => getJson(runsUrl(query), isRunsResponse),
  fetchSummary: () => getJson("/api/summary", isSummaryResponse),
  fetchLaneEvents: (query = {}) => getJson(laneEventsUrl(query), isLaneEventsResponse),
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
