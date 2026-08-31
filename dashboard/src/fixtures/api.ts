import type { LaneEventsQuery, RunsQuery, TelemetryApi } from "@/api/client";
import { MAX_LIMIT_WITH_BLOBS } from "@/api/client";
import type { LaneEventsResponse, RoundRow, RunsResponse, SummaryResponse } from "@/api/types";
import { FIXTURE_ROUNDS } from "./rounds";

const BLOB_COLUMNS = [
  "per_model_usage",
  "subagent_stats",
  "raw_result",
  "verdict_text",
  "comment_node_ids",
  "config_resolution",
] as const;

/**
 * Reimplements handleRuns and handleSummary from worker/index.js against an
 * in-memory table, so the routes can be exercised without Access. Filter,
 * ordering, limit and cursor semantics have to match the Worker exactly, or a
 * green test proves nothing about the deployed contract.
 */
export function makeFixtureApi(rows: RoundRow[] = FIXTURE_ROUNDS): TelemetryApi {
  const sorted = [...rows].sort((a, b) => {
    const byTime = b.recorded_at.localeCompare(a.recorded_at);
    return byTime !== 0 ? byTime : b.session_id.localeCompare(a.session_id);
  });

  return {
    fixtures: true,

    async fetchRuns(query: RunsQuery = {}): Promise<RunsResponse> {
      const includeBlobs = query.include === "blobs";
      let limit = query.limit ?? 100;
      if (includeBlobs) limit = Math.min(limit, MAX_LIMIT_WITH_BLOBS);

      let filtered = sorted;
      if (query.repository) filtered = filtered.filter((r) => r.repository === query.repository);
      if (query.round_type) filtered = filtered.filter((r) => r.round_type === query.round_type);
      if (query.since) filtered = filtered.filter((r) => r.recorded_at >= query.since!);
      if (query.until) filtered = filtered.filter((r) => r.recorded_at <= query.until!);
      if (query.cursor) {
        const pipe = query.cursor.indexOf("|");
        const cursorAt = query.cursor.slice(0, pipe);
        const cursorId = query.cursor.slice(pipe + 1);
        filtered = filtered.filter(
          (r) =>
            r.recorded_at < cursorAt || (r.recorded_at === cursorAt && r.session_id < cursorId),
        );
      }

      const page = filtered.slice(0, limit).map((row) => {
        if (includeBlobs) return { ...row };
        const stripped = { ...row };
        for (const column of BLOB_COLUMNS) delete stripped[column];
        return stripped;
      });

      const last = page[page.length - 1];
      return {
        rows: page,
        next_cursor:
          page.length === limit && last ? `${last.recorded_at}|${last.session_id}` : null,
      };
    },

    async fetchSummary(): Promise<SummaryResponse> {
      if (sorted.length === 0) {
        return {
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
          canary_last_seen_at: null,
        };
      }
      const durations = sorted
        .map((r) => r.duration_ms)
        .filter((d): d is number => typeof d === "number")
        .sort((a, b) => a - b);
      const sum = (pick: (r: RoundRow) => number | null) =>
        sorted.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
      const input = sum((r) => r.input_tokens);
      const read = sum((r) => r.cache_read_input_tokens);
      const create = sum((r) => r.cache_creation_input_tokens);
      const total = input + read + create;
      const billed = input + 1.25 * create + 0.1 * read;

      const verdict_kinds: Record<string, number> = {};
      const fallback_reasons: Record<string, number> = {};
      const model_sources: Record<string, number> = {};
      for (const r of sorted) {
        if (r.verdict_kind) verdict_kinds[r.verdict_kind] = (verdict_kinds[r.verdict_kind] ?? 0) + 1;
        if (r.fallback_reason) fallback_reasons[r.fallback_reason] = (fallback_reasons[r.fallback_reason] ?? 0) + 1;
        if (r.model_source) model_sources[r.model_source] = (model_sources[r.model_source] ?? 0) + 1;
      }

      return {
        rows: sorted.length,
        repositories: [...new Set(sorted.map((r) => r.repository))].sort(),
        wall_clock_ms: {
          mean: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
          p95: durations.length
            ? durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)]
            : null,
        },
        denials_per_run: sum((r) => r.permission_denials) / sorted.length,
        cache_hit_rate: total > 0 ? read / total : null,
        caching_multiplier: billed > 0 ? total / billed : null,
        total_cost_usd: sum((r) => r.total_cost_usd),
        first_recorded_at: sorted[sorted.length - 1].recorded_at,
        last_recorded_at: sorted[0].recorded_at,
        verdict_kinds,
        fallback_reasons,
        model_sources,
        canary_last_seen_at: null,
      };
    },

    async fetchLaneEvents(_query: LaneEventsQuery = {}): Promise<LaneEventsResponse> {
      return { rows: [], next_cursor: null };
    },
  };
}
