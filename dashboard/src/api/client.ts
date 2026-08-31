import type { RoundRow, RunsResponse, SummaryResponse } from "./types";

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

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      redirect: "follow",
    });
  } catch (cause) {
    throw new ApiError(`could not reach the telemetry Worker: ${String(cause)}`, 0, "network");
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(
      "the Worker answered with a non-JSON body, which is what Cloudflare Access serves when the session has expired",
      res.status,
      "unauthenticated",
    );
  }

  if (res.status === 403 || res.status === 401) {
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

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(`GET ${path} returned a body that is not valid JSON`, res.status, "malformed");
  }
}

export interface TelemetryApi {
  fetchRuns(query?: RunsQuery): Promise<RunsResponse>;
  fetchSummary(): Promise<SummaryResponse>;
}

export const httpApi: TelemetryApi = {
  fetchRuns: (query = {}) => getJson<RunsResponse>(runsUrl(query)),
  fetchSummary: () => getJson<SummaryResponse>("/api/summary"),
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
