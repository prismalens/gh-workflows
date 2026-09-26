import { parseUnaccountedRuns } from "@/api/blobs";
import type {
  ChangesQuery,
  FindingsQuery,
  FleetFindingsQuery,
  FleetReposQuery,
  HealthReportsQuery,
  LaneEventsQuery,
  PrsQuery,
  RunsQuery,
  TelemetryApi,
} from "@/api/client";
import { MAX_LIMIT_WITH_BLOBS } from "@/api/client";
import type {
  ChangeRow,
  ChangesResponse,
  FindingRow,
  FindingsResponse,
  FleetFindingsCounts,
  FleetFindingsRepo,
  FleetFindingsResponse,
  FleetRepoRow,
  FleetReposResponse,
  HealthReportRow,
  HealthReportsResponse,
  LaneEventRow,
  LaneEventsResponse,
  OpsIdentityRow,
  OpsIdentityTable,
  OpsResponse,
  PrRow,
  PrsResponse,
  RoundAgentRow,
  RoundAgentsResponse,
  RoundRow,
  RunsResponse,
  SummaryResponse,
} from "@/api/types";
import { summariseConfigs } from "@/features/failures/failures";
import { decodeDivergence, decodeFate, fixCitation } from "@/features/findings/findings";
import { reviewToMergeHours } from "@/features/findings/latency";
import { applyRange } from "@/honesty/range";
import { FIXTURE_PRS } from "./prs";
import { FIXTURE_ROUNDS } from "./rounds";

const BLOB_COLUMNS = [
  "per_model_usage",
  "subagent_stats",
  "raw_result",
  "verdict_text",
  "comment_node_ids",
  "config_resolution",
  "config_effective",
] as const;

const HEALTH_BLOB_COLUMNS = ["unaccounted_runs", "lane_events_by_reason"] as const;

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
  findings: FindingRow[] = [],
  healthReports: HealthReportRow[] = [],
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

  const sortedFindings = [...findings].sort((a, b) => {
    const byTime = (b.thread_created_at ?? "").localeCompare(a.thread_created_at ?? "");
    return byTime !== 0 ? byTime : b.thread_node_id.localeCompare(a.thread_node_id);
  });

  const sortedHealth = [...healthReports].sort((a, b) => {
    const byWindow = b.window_start.localeCompare(a.window_start);
    return byWindow !== 0 ? byWindow : b.id - a.id;
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

    async fetchFindings(query: FindingsQuery = {}): Promise<FindingsResponse> {
      let filtered = sortedFindings;
      if (query.repository) filtered = filtered.filter((r) => r.repository === query.repository);
      if (query.pr_number) filtered = filtered.filter((r) => r.pr_number === query.pr_number);
      if (query.cursor) {
        const pipe = query.cursor.lastIndexOf("|");
        const cursorAt = query.cursor.slice(0, pipe);
        const cursorId = query.cursor.slice(pipe + 1);
        filtered = filtered.filter(
          (r) =>
            (r.thread_created_at ?? "") < cursorAt ||
            ((r.thread_created_at ?? "") === cursorAt && r.thread_node_id < cursorId),
        );
      }
      const limit = query.limit ?? 1000;
      const page = filtered.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page,
        next_cursor:
          page.length === limit && last
            ? `${last.thread_created_at ?? ""}|${last.thread_node_id}`
            : null,
      };
    },

    // The window goes through applyRange itself, so the fixture and the Worker's
    // mirror of that rule are one rule, not two that can drift (#185).
    async fetchFleetRepos({ range }: FleetReposQuery): Promise<FleetReposResponse> {
      const now = new Date();
      const windowed = applyRange(sorted, range, now);

      const lastRecorded = new Map<string, string>();
      for (const r of sorted) {
        if (!lastRecorded.has(r.repository)) lastRecorded.set(r.repository, r.recorded_at);
      }

      const inWindow = new Map<string, Omit<FleetRepoRow, "restacks">>();
      for (const r of windowed.rows) {
        const entry = inWindow.get(r.repository);
        if (entry) {
          entry.rounds += 1;
          entry.denials += r.permission_denials ?? 0;
          continue;
        }
        inWindow.set(r.repository, {
          repository: r.repository,
          rounds: 1,
          denials: r.permission_denials ?? 0,
          last_round: {
            session_id: r.session_id,
            recorded_at: r.recorded_at,
            round_type: r.round_type,
            verdict_kind: r.verdict_kind,
          },
          last_recorded_at: null,
        });
      }

      const unmergedBase = new Map<string, number>();
      for (const r of windowed.rows) {
        if (r.base_pr_number != null) {
          unmergedBase.set(r.repository, (unmergedBase.get(r.repository) ?? 0) + 1);
        }
      }
      const windowStart = windowed.rows[windowed.rows.length - 1]?.recorded_at;
      const unchangedPatch = new Map<string, number>();
      for (const e of sortedEvents) {
        if (e.reason !== "unchanged-patch") continue;
        if (range !== "all" && (!windowStart || e.recorded_at < windowStart)) continue;
        unchangedPatch.set(e.repository, (unchangedPatch.get(e.repository) ?? 0) + 1);
      }

      const names = [...new Set([...lastRecorded.keys(), ...inWindow.keys()])].sort();
      const repositories = names.map((repository) => ({
        ...(inWindow.get(repository) ?? {
          repository,
          rounds: 0,
          denials: 0,
          last_round: null,
        }),
        last_recorded_at: lastRecorded.get(repository) ?? null,
        restacks: {
          unchanged_patch: unchangedPatch.get(repository) ?? 0,
          unmerged_base: unmergedBase.get(repository) ?? 0,
        },
      }));

      const DAY_MS = 24 * 60 * 60 * 1000;
      // The Worker's since for the 50-round side is the 50th round, or none at
      // all when fewer than 50 exist.
      const since =
        range === "all"
          ? null
          : range === "rolling" && windowed.label === "the last 50 rounds"
            ? (sorted[49]?.recorded_at ?? null)
            : new Date(
                now.getTime() - (range === "90d" ? 90 : range === "30d" ? 30 : 7) * DAY_MS,
              ).toISOString();

      return {
        window: { range, since, label: windowed.label },
        rounds: windowed.rows.length,
        repositories,
        malformed_configs: summariseConfigs(windowed.rows)
          .items.filter(
            (item) => item.outcome === "unparseable" || item.outcome === "schema-rejected",
          )
          .map((item) => ({ repository: item.repository, layer: item.layer })),
        };
      },

    // The Worker's /api/ops over the same 7 days, from the fixture tables (#179).
    async fetchOps(): Promise<OpsResponse> {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const identity = new Map<string, OpsIdentityRow["tables"]>();
      const tally = (repository: string, table: OpsIdentityTable, auth: string | null | undefined) => {
        const tables = identity.get(repository) ?? {};
        const counts = (tables[table] ??= {});
        const key = auth || "unrecorded";
        counts[key] = (counts[key] ?? 0) + 1;
        identity.set(repository, tables);
      };
      const credentials = new Map<string, number>();
      for (const r of sorted) {
        if (r.recorded_at < since) continue;
        tally(r.repository, "usage_records", r.ingest_auth);
        const key = JSON.stringify([r.repository, r.credential_type ?? null]);
        credentials.set(key, (credentials.get(key) ?? 0) + 1);
      }
      // Lane event rows are read without ingest_auth, so the fixture cannot say who wrote them.
      for (const e of sortedEvents) {
        if (e.recorded_at >= since) tally(e.repository, "lane_events", null);
      }
      const health = new Map<string, OpsResponse["health"][number]>();
      for (const h of sortedHealth) {
        if (h.received_at < since) continue;
        const entry = health.get(h.repository) ?? {
          repository: h.repository,
          reports: 0,
          last_received_at: h.received_at,
          unaccounted: 0,
          startup_failures: 0,
        };
        entry.reports += 1;
        if (h.received_at > entry.last_received_at) entry.last_received_at = h.received_at;
        entry.unaccounted += parseUnaccountedRuns(h)?.length ?? 0;
        entry.startup_failures += h.startup_failures;
        health.set(h.repository, entry);
      }
      return {
        window: { since, days: 7 },
        identity: [...identity.keys()].sort().map((repository) => ({
          repository,
          tables: identity.get(repository)!,
        })),
        credentials: [...credentials.entries()]
          .map(([key, rounds]) => {
            const [repository, credential_type] = JSON.parse(key) as [string, string | null];
            return { repository, credential_type, rounds };
          })
          .sort((a, b) =>
            a.repository === b.repository
              ? String(a.credential_type).localeCompare(String(b.credential_type))
              : a.repository.localeCompare(b.repository),
          ),
        health: [...health.values()].sort((a, b) => a.repository.localeCompare(b.repository)),
        worker: { version_id: null, version_tag: null, version_timestamp: null, d1_size_bytes: null },
      };
    },

    async fetchHealthReports(query: HealthReportsQuery = {}): Promise<HealthReportsResponse> {
      let filtered = sortedHealth;
      if (query.repository) filtered = filtered.filter((r) => r.repository === query.repository);
      if (query.cursor) {
        const pipe = query.cursor.lastIndexOf("|");
        const cursorAt = query.cursor.slice(0, pipe);
        const cursorId = Number(query.cursor.slice(pipe + 1));
        filtered = filtered.filter(
          (r) => r.window_start < cursorAt || (r.window_start === cursorAt && r.id < cursorId),
        );
      }
      const limit = query.limit ?? 52;
      const includeBlobs = query.include === "blobs";
      const page = filtered.slice(0, limit).map((row) => {
        if (includeBlobs) return { ...row };
        const stripped = { ...row };
        for (const column of HEALTH_BLOB_COLUMNS) delete stripped[column];
        return stripped;
      });
      const last = page[page.length - 1];
      return {
        rows: page,
        next_cursor: page.length === limit && last ? `${last.window_start}|${last.id}` : null,
      };
    },

    // Decoded with the rows page's own functions, so the fixture cannot drift
    // from what the rows view shows; the Worker's SQL is pinned separately (#185 F3).
    async fetchFleetFindings({ pr_state }: FleetFindingsQuery): Promise<FleetFindingsResponse> {
      const stateOf = new Map(sortedPrs.map((p) => [`${p.repository}#${p.pr_number}`, p]));
      const inFilter = sortedFindings.filter(
        (f) => !pr_state || stateOf.get(`${f.repository}#${f.pr_number}`)?.state === pr_state,
      );
      const zero = (): FleetFindingsCounts => ({
        findings: 0,
        never_answered: 0,
        pushback_open: 0,
        resolved_by_human: 0,
        self_graded: 0,
        fix_cited: 0,
        still_applies: 0,
        verified_fixed_but_open: 0,
        not_addressed_but_resolved: 0,
        incomplete_prs: 0,
      });
      const byRepo = new Map<string, FleetFindingsRepo>();
      const incomplete = new Set<string>();
      for (const f of inFilter) {
        let entry = byRepo.get(f.repository);
        if (!entry) {
          entry = { repository: f.repository, ...zero(), review_to_merge_hours: [] };
          byRepo.set(f.repository, entry);
        }
        entry.findings += 1;
        const fate = decodeFate(f);
        if (fate === "never-answered") entry.never_answered += 1;
        else if (fate === "pushback-open") entry.pushback_open += 1;
        else if (fate === "resolved-by-human") entry.resolved_by_human += 1;
        else entry.self_graded += 1;
        if (fixCitation(f)) entry.fix_cited += 1;
        if (f.verify_verdict === "still_applies") entry.still_applies += 1;
        const divergence = decodeDivergence(f);
        if (divergence === "verified-fixed-but-open") entry.verified_fixed_but_open += 1;
        if (divergence === "not-addressed-but-resolved") entry.not_addressed_but_resolved += 1;
        const key = `${f.repository}#${f.pr_number}`;
        if (f.row_set_incomplete === 1 && !incomplete.has(key)) {
          incomplete.add(key);
          entry.incomplete_prs += 1;
        }
      }
      for (const pr of sortedPrs) {
        const entry = byRepo.get(pr.repository);
        if (!entry) continue;
        const hours = reviewToMergeHours(inFilter, pr);
        if (hours !== null) entry.review_to_merge_hours.push(hours);
      }
      const repositories = [...byRepo.values()].sort((a, b) =>
        a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0,
      );
      for (const r of repositories) r.review_to_merge_hours.sort((a, b) => a - b);
      const totals = zero();
      for (const r of repositories) {
        for (const key of Object.keys(totals) as (keyof FleetFindingsCounts)[]) totals[key] += r[key];
      }
      return {
        filter: { repository: null, pr_state: pr_state ?? null },
        totals,
        repositories,
        review_to_merge_hours: repositories
          .flatMap((r) => r.review_to_merge_hours)
          .sort((a, b) => a - b),
      };
    },
  };
}
