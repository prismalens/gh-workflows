import { useQuery } from "@tanstack/react-query";

import { rangeSince, type RangeKey } from "@/honesty/range";
import {
  lookupRound,
  MAX_LIMIT,
  MAX_LIMIT_WITH_BLOBS,
  type LaneEventsQuery,
  type RunsQuery,
  type TelemetryApi,
} from "./client";
import { useApi } from "./provider";
import type { RoundRow } from "./types";

export interface RoundsFilters {
  range: RangeKey;
  repository?: string;
  roundType?: string;
}

/**
 * One page of at most MAX_LIMIT rounds. The Worker paginates by cursor, but the
 * range tiles are computed over what is loaded, so loading more rows underneath
 * a tile would quietly change its n. The cap is stated on screen instead.
 */
export function useRoundsQuery(filters: RoundsFilters, now: Date) {
  const api = useApi();
  const since = rangeSince(filters.range, now);
  const query: RunsQuery = {
    limit: MAX_LIMIT,
    ...(filters.repository ? { repository: filters.repository } : {}),
    ...(filters.roundType ? { round_type: filters.roundType } : {}),
    ...(since ? { since } : {}),
  };

  return useQuery({
    queryKey: ["runs", query],
    queryFn: () => api.fetchRuns(query),
    staleTime: 30_000,
  });
}

/**
 * A second, deliberately smaller page for the attention feed. `is_error` and the
 * denied tool names are inside raw_result, which only arrives with include=blobs,
 * and the Worker caps a blob page at MAX_LIMIT_WITH_BLOBS. So the feed reads the
 * most recent rounds of the window rather than all of them, and the screen says
 * how many it read.
 */
export function useAttentionQuery(filters: RoundsFilters, now: Date) {
  const api = useApi();
  const since = rangeSince(filters.range, now);
  const query: RunsQuery = {
    include: "blobs",
    limit: MAX_LIMIT_WITH_BLOBS,
    ...(filters.repository ? { repository: filters.repository } : {}),
    ...(filters.roundType ? { round_type: filters.roundType } : {}),
    ...(since ? { since } : {}),
  };

  return useQuery({
    queryKey: ["runs", query],
    queryFn: () => api.fetchRuns(query),
    staleTime: 30_000,
  });
}

export function useSummaryQuery() {
  const api = useApi();
  return useQuery({
    queryKey: ["summary"],
    queryFn: () => api.fetchSummary(),
    staleTime: 60_000,
  });
}

export function useRoundQuery(sessionId: string, recordedAt?: string) {
  const api = useApi();
  return useQuery({
    queryKey: ["round", sessionId, recordedAt ?? null],
    queryFn: () => lookupRound(api, sessionId, recordedAt),
    staleTime: 5 * 60_000,
  });
}

export function useRoundAgentsQuery(sessionId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ["round-agents", sessionId],
    queryFn: () => api.fetchRoundAgents(sessionId),
    staleTime: 5 * 60_000,
  });
}

export function distinctRoundTypes(rows: RoundRow[]): string[] {
  return [...new Set(rows.map((row) => row.round_type).filter((t): t is string => !!t))].sort();
}

export interface LaneEventsFilters {
  range: RangeKey;
  repository?: string;
}

export function useLaneEventsQuery(filters: LaneEventsFilters, now: Date) {
  const api = useApi();
  const since = rangeSince(filters.range, now);
  const query: LaneEventsQuery = {
    limit: MAX_LIMIT,
    ...(filters.repository ? { repository: filters.repository } : {}),
    ...(since ? { since } : {}),
  };

  return useQuery({
    queryKey: ["lane-events", query],
    queryFn: () => api.fetchLaneEvents(query),
    staleTime: 30_000,
  });
}

export function useChangesQuery() {
  const api = useApi();
  return useQuery({
    queryKey: ["changes"],
    queryFn: () => api.fetchChanges(),
    staleTime: 30_000,
  });
}

export type PRLookup =
  | { found: true; rounds: RoundRow[] }
  | { found: false };

export async function lookupPR(
  api: TelemetryApi,
  repository: string,
  prNumber: number,
): Promise<PRLookup> {
  // Reject non-positive or non-integer PR numbers (finding 3943781319).
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { found: false };
  }

  // Follow next_cursor across all readable pages (finding 3943781301).
  let cursor: string | undefined;
  const matching: RoundRow[] = [];
  do {
    const response = await api.fetchRuns({
      repository,
      limit: MAX_LIMIT,
      cursor,
    });
    for (const r of response.rows) {
      if (r.pr_number === prNumber) {
        matching.push(r);
      }
    }
    cursor = response.next_cursor ?? undefined;
  } while (cursor);

  if (matching.length === 0) {
    return { found: false };
  }

  const withBlobs = await Promise.all(
    matching.map(async (row: RoundRow) => {
      try {
        const exact = await api.fetchRuns({
          repository,
          since: row.recorded_at,
          until: row.recorded_at,
          include: "blobs",
          limit: MAX_LIMIT_WITH_BLOBS,
        });
        const hit = exact.rows.find((r: RoundRow) => r.session_id === row.session_id);
        return hit ?? row;
      } catch {
        return row;
      }
    }),
  );

  withBlobs.sort((a: RoundRow, b: RoundRow) => b.recorded_at.localeCompare(a.recorded_at));
  return { found: true, rounds: withBlobs };
}

export function usePRDetailQuery(repository: string, prNumber: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["pr", repository, prNumber],
    queryFn: () => (prNumber !== null ? lookupPR(api, repository, prNumber) : Promise.resolve<PRLookup>({ found: false })),
    enabled: prNumber !== null,
    staleTime: 30_000,
  });
}

