import type { ChangesQuery, LaneEventsQuery, PrsQuery, RunsQuery, TelemetryApi } from "@/api/client";
import { MAX_LIMIT_WITH_BLOBS } from "@/api/client";
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
} from "@/api/types";
import { FIXTURE_PRS } from "./prs";
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
 * Reimplements handleRuns, handleSummary, handleLaneEvents and handleChanges from
 * worker/index.js against an in-memory table, so the routes can be exercised without Access.
 * Filter, ordering, limit and cursor semantics have to match the Worker exactly, or a
 * green test proves nothing about the deployed contract.
 */
export function makeFixtureApi(
  rows: RoundRow[] = FIXTURE_ROUNDS,
  laneEvents: LaneEventRow[] = [],
  changes: ChangeRow[] = [],
  roundAgents: Record<string, RoundAgentRow[]> | RoundAgentRow[] = [],
  // Defaults to the real fixture prs set only when rows is also left at its
  // default, so every existing caller that passes its own rows keeps today's
  // fallback-only behaviour (#141).
  prs: PrRow[] = rows === FIXTURE_ROUNDS ? FIXTURE_PRS : [],
): TelemetryApi {
  const sorted = [...rows].sort((a, b) => {
    const byTime = b.recorded_at.localeCompare(a.recorded_at);
    return byTime !== 0 ? byTime : b.session_id.localeCompare(a.session_id);
  });

  const sortedPrs = [...prs].sort((a, b) => {
    const byTime = b.updated_at.localeCompare(a.updated_at);
    if (byTime !== 0) return byTime;
    const byRepo = b.repository.localeCompare(a.repository);
    return byRepo !== 0 ? byRepo : b.pr_number - a.pr_number;
  });

  const sortedEvents = [...laneEvents].sort((a, b) => {
    const byTime = b.recorded_at.localeCompare(a.recorded_at);
    return byTime !== 0 ? byTime : b.run_id - a.run_id;
  });

  const sortedChanges = [...changes].sort((a, b) => {
    const byTime = b.at.localeCompare(a.at);
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
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

      // sorted is newest-first, so the first row seen per repository is its last round.
      const perRepo = new Map<string, { rounds: number; last_recorded_at: string }>();
      for (const r of sorted) {
        const entry = perRepo.get(r.repository);
        if (entry) entry.rounds += 1;
        else perRepo.set(r.repository, { rounds: 1, last_recorded_at: r.recorded_at });
      }
      const per_repository = [...perRepo.entries()]
        .map(([repository, entry]) => ({ repository, ...entry }))
        .sort((a, b) => a.repository.localeCompare(b.repository));

      return {
        rows: sorted.length,
        repositories: [...new Set(sorted.map((r) => r.repository))].sort(),
        per_repository,
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

    async fetchLaneEvents(query: LaneEventsQuery = {}): Promise<LaneEventsResponse> {
      let filtered = sortedEvents;
      if (query.repository) filtered = filtered.filter((r) => r.repository === query.repository);
      if (query.since) filtered = filtered.filter((r) => r.recorded_at >= query.since!);
      if (query.until) filtered = filtered.filter((r) => r.recorded_at <= query.until!);
      if (query.cursor) {
        const pipe = query.cursor.indexOf("|");
        const cursorAt = query.cursor.slice(0, pipe);
        const cursorId = Number(query.cursor.slice(pipe + 1));
        filtered = filtered.filter(
          (r) => r.recorded_at < cursorAt || (r.recorded_at === cursorAt && r.run_id < cursorId),
        );
      }
      const limit = query.limit ?? 100;
      const page = filtered.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page,
        next_cursor:
          page.length === limit && last ? `${last.recorded_at}|${last.run_id}` : null,
      };
    },

    async fetchChanges(query: ChangesQuery = {}): Promise<ChangesResponse> {
      let filtered = sortedChanges;
      if (query.cursor) {
        const pipe = query.cursor.indexOf("|");
        const cursorAt = query.cursor.slice(0, pipe);
        const cursorId = query.cursor.slice(pipe + 1);
        filtered = filtered.filter(
          (c) => c.at < cursorAt || (c.at === cursorAt && c.id < cursorId),
        );
      }
      const limit = query.limit ?? 100;
      const page = filtered.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page,
        next_cursor:
          page.length === limit && last ? `${last.at}|${last.id}` : null,
      };
    },

    async fetchRoundAgents(sessionId: string): Promise<RoundAgentsResponse> {
      let matching: RoundAgentRow[] = [];
      if (Array.isArray(roundAgents)) {
        matching = roundAgents.filter((r) => r.session_id === sessionId);
      } else if (roundAgents && typeof roundAgents === "object") {
        matching = roundAgents[sessionId] ?? [];
      }
      return {
        rows: matching,
        next_cursor: null,
      };
    },

    async fetchPRs(query: PrsQuery = {}): Promise<PrsResponse> {
      let filtered = sortedPrs;
      if (query.repository) filtered = filtered.filter((r) => r.repository === query.repository);
      if (query.state) filtered = filtered.filter((r) => r.state === query.state);
      if (query.cursor) {
        const firstPipe = query.cursor.indexOf("|");
        const lastPipe = query.cursor.lastIndexOf("|");
        const cursorAt = query.cursor.slice(0, firstPipe);
        const cursorRepo = query.cursor.slice(firstPipe + 1, lastPipe);
        const cursorNumber = Number(query.cursor.slice(lastPipe + 1));
        filtered = filtered.filter(
          (r) =>
            r.updated_at < cursorAt ||
            (r.updated_at === cursorAt &&
              (r.repository < cursorRepo ||
                (r.repository === cursorRepo && r.pr_number < cursorNumber))),
        );
      }
      const limit = query.limit ?? 100;
      const page = filtered.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page,
        next_cursor:
          page.length === limit && last
            ? `${last.updated_at}|${last.repository}|${last.pr_number}`
            : null,
      };
    },
  };
}
