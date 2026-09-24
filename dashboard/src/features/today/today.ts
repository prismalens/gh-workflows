import type { FindingRow, FleetReposResponse, PrRow, RoundRow } from "@/api/types";
import { decodeFate } from "@/features/findings/findings";
import { enrichPRs, groupRoundsByPR, type PRSummary } from "@/features/prs/prs";
import { ageInDays } from "@/lib/format";

const DAY_MS = 86_400_000;

export type NeedKind = "failed" | "never-answered" | "pushback" | "did-not-run" | "head-not-read";

/** Higher is louder. A failure beats a stale thread; a skipped head is last. */
const NEED_WEIGHT: Record<NeedKind, number> = {
  failed: 5,
  "never-answered": 4,
  pushback: 4,
  "did-not-run": 3,
  "head-not-read": 1,
};

export interface NeedItem {
  id: string;
  kind: NeedKind;
  repository: string;
  prNumber: number;
  what: string;
  detail: string | null;
  action: string;
  /** `@claude review` and similar, copied rather than navigated. */
  copyText: string | null;
  since: string | null;
  ageDays: number | null;
}

export interface Anomaly {
  id: string;
  title: string;
  detail: string;
  repository: string | null;
  link: { to: "/rounds" | "/findings" | "/repos/$owner/$repo"; search?: Record<string, string> } | null;
}

export interface WeekStat {
  label: string;
  value: number | null;
  previous: number | null;
  /** Which direction is bad, for colouring a change. */
  worseWhen: "up" | "down" | null;
  format: "count" | "duration" | "percent";
  note?: string;
}

export interface RepoLine {
  repository: string;
  state: "failing" | "config malformed" | "tool denials" | "quiet" | "healthy";
  rounds: number;
  denials: number;
  openThreads: number;
  lastRoundAt: string | null;
  perDay: number[];
}

export interface TodayModel {
  problems: string[];
  lastRoundAt: string | null;
  repositoriesPosting: number;
  needs: NeedItem[];
  anomalies: Anomaly[];
  week: WeekStat[];
  repos: RepoLine[];
}

function latestPrState(pr: PRSummary): string {
  return pr.stateIsFallback ? (pr.latestRound.pr_state ?? pr.state) : pr.state;
}

function isOpen(pr: PRSummary | undefined): boolean {
  if (!pr) return true;
  return latestPrState(pr) === "open";
}

function p95(values: number[]): number | null {
  if (values.length < 5) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

function inWindow(iso: string | null, from: number, to: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= from && t < to;
}

/**
 * Everything Today shows, from rows the Inbox already reads (#209). Rounds span
 * two weeks so this week can be compared with the one before; findings are the
 * sweep's current state, so they carry no window.
 */
export function buildToday(input: {
  rounds: RoundRow[];
  prs: PrRow[];
  findings: FindingRow[];
  fleet: FleetReposResponse | undefined;
  now: Date;
}): TodayModel {
  const { rounds, prs, findings, fleet, now } = input;
  const nowMs = now.getTime();
  const weekStart = nowMs - 7 * DAY_MS;
  const prevStart = nowMs - 14 * DAY_MS;
  const thisWeek = rounds.filter((r) => inWindow(r.recorded_at, weekStart, nowMs + 1));
  const lastWeek = rounds.filter((r) => inWindow(r.recorded_at, prevStart, weekStart));

  const summaries = enrichPRs(groupRoundsByPR(rounds), prs);
  const byKey = new Map(summaries.map((p) => [`${p.repository}#${p.number}`, p]));

  const needs: NeedItem[] = [];
  for (const pr of summaries) {
    if (!isOpen(pr)) continue;
    const since = pr.lastRoundAt;
    const base = { repository: pr.repository, prNumber: pr.number, since, ageDays: ageInDays(since, now) };
    switch (pr.headStatus.state) {
      case "failed":
        needs.push({ ...base, id: `failed:${pr.id}`, kind: "failed", what: "Review failed on the latest head", detail: pr.headStatus.explain, action: "Copy @claude review", copyText: "@claude review" });
        break;
      case "did-not-run":
        needs.push({ ...base, id: `dnr:${pr.id}`, kind: "did-not-run", what: "No review on the latest head", detail: pr.headStatus.rawVerdict ?? pr.headStatus.explain, action: "Open the PR", copyText: null });
        break;
      case "threads-only":
        needs.push({ ...base, id: `threads:${pr.id}`, kind: "head-not-read", what: "Head not reviewed: the last round only re-checked threads", detail: null, action: "Copy @claude review", copyText: pr.headStatus.copyableHint ?? "@claude review" });
        break;
      default:
        break;
    }
  }

  const findingGroups = new Map<string, { kind: "never-answered" | "pushback"; rows: FindingRow[] }>();
  for (const row of findings) {
    const fate = decodeFate(row);
    if (fate !== "never-answered" && fate !== "pushback-open") continue;
    const prKey = `${row.repository}#${row.pr_number}`;
    if (!isOpen(byKey.get(prKey))) continue;
    const kind = fate === "never-answered" ? "never-answered" : "pushback";
    const key = `${kind}:${prKey}`;
    const group = findingGroups.get(key) ?? { kind, rows: [] };
    group.rows.push(row);
    findingGroups.set(key, group);
  }
  for (const [id, group] of findingGroups) {
    const first = group.rows[0]!;
    const oldest = group.rows.reduce<string | null>((acc, r) => {
      const t = r.thread_created_at;
      return t && (!acc || t < acc) ? t : acc;
    }, null);
    const n = group.rows.length;
    const paths = group.rows.map((r) => `${r.path ?? "?"}${r.original_line !== null ? `:${r.original_line}` : ""}`);
    needs.push({
      id,
      kind: group.kind,
      repository: first.repository,
      prNumber: first.pr_number,
      what:
        group.kind === "never-answered"
          ? n === 1 ? "Finding never answered" : `${n} findings never answered`
          : n === 1 ? "Pushback left open" : `${n} pushbacks left open`,
      detail: paths.slice(0, 2).join(", ") + (paths.length > 2 ? ` and ${paths.length - 2} more` : ""),
      action: group.kind === "never-answered" ? (n === 1 ? "Answer thread" : `Answer ${n} threads`) : "Reply to pushback",
      copyText: null,
      since: oldest,
      ageDays: ageInDays(oldest, now),
    });
  }
  needs.sort((a, b) => NEED_WEIGHT[b.kind] - NEED_WEIGHT[a.kind] || (b.ageDays ?? 0) - (a.ageDays ?? 0));

  const lastRoundAt = rounds.reduce<string | null>((acc, r) => (!acc || r.recorded_at > acc ? r.recorded_at : acc), null);
  const reposThisWeek = new Set(thisWeek.map((r) => r.repository));

  const problems: string[] = [];
  for (const m of fleet?.malformed_configs ?? []) {
    problems.push(`${m.repository}: its ${m.layer} config layer is malformed, so the lane runs on workflow defaults.`);
  }
  const failedToday = thisWeek.filter((r) => r.job_conclusion === "failure" && inWindow(r.recorded_at, nowMs - DAY_MS, nowMs + 1));
  if (failedToday.length > 0) {
    problems.push(`${failedToday.length} round${failedToday.length === 1 ? "" : "s"} failed in the last 24 hours.`);
  }

  const anomalies: Anomaly[] = [];
  const denialsByRepo = new Map<string, { denials: number; rounds: number; slow: number[] }>();
  for (const r of thisWeek) {
    const entry = denialsByRepo.get(r.repository) ?? { denials: 0, rounds: 0, slow: [] };
    entry.denials += r.permission_denials ?? 0;
    entry.rounds += 1;
    if ((r.permission_denials ?? 0) >= 15 && r.duration_ms) entry.slow.push(r.duration_ms);
    denialsByRepo.set(r.repository, entry);
  }
  const totalDenials = [...denialsByRepo.values()].reduce((s, e) => s + e.denials, 0);
  for (const [repository, e] of denialsByRepo) {
    const perRound = e.rounds ? e.denials / e.rounds : 0;
    if (e.denials < 20 || perRound < 2) continue;
    const others = totalDenials - e.denials;
    const slow = e.slow.length
      ? ` Rounds with 15 or more denials ran ${Math.round(Math.min(...e.slow) / 60000)} to ${Math.round(Math.max(...e.slow) / 60000)} minutes.`
      : "";
    anomalies.push({
      id: `denials:${repository}`,
      title: `The lane was denied tools ${e.denials} times on ${repository}`,
      detail: `${perRound.toFixed(1)} denials a round.${slow} Every other repository logged ${others} between them.`,
      repository,
      link: { to: "/rounds", search: { repository } },
    });
  }
  const failedWeek = thisWeek.filter((r) => r.job_conclusion === "failure").length;
  const failedPrev = lastWeek.filter((r) => r.job_conclusion === "failure").length;
  if (failedWeek >= 3 && failedWeek > failedPrev * 2) {
    anomalies.push({
      id: "failures",
      title: `${failedWeek} rounds failed this week, against ${failedPrev} the week before`,
      detail: "Failure classes and whether a retry helps are on the round pages.",
      repository: null,
      link: { to: "/rounds" },
    });
  }
  for (const repo of fleet?.repositories ?? []) {
    const last = repo.last_recorded_at ? new Date(repo.last_recorded_at).getTime() : null;
    if (last !== null && nowMs - last > 7 * DAY_MS && nowMs - last < 60 * DAY_MS) {
      anomalies.push({
        id: `silent:${repo.repository}`,
        title: `${repo.repository} has posted nothing for ${Math.floor((nowMs - last) / DAY_MS)} days`,
        detail: "A quiet repository and a dead lane look the same until lane events say otherwise.",
        repository: repo.repository,
        link: { to: "/repos/$owner/$repo" },
      });
    }
  }

  const prCount = (rows: RoundRow[]) => new Set(rows.map((r) => `${r.repository}#${r.pr_number}`)).size;
  const durations = (rows: RoundRow[]) => rows.map((r) => r.duration_ms).filter((d): d is number => d !== null);
  const cacheHit = (rows: RoundRow[]) => {
    let read = 0;
    let all = 0;
    for (const r of rows) {
      read += r.cache_read_input_tokens ?? 0;
      all += (r.input_tokens ?? 0) + (r.cache_read_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0);
    }
    return all > 0 ? read / all : null;
  };
  const findingsPosted = (from: number, to: number) => findings.filter((f) => inWindow(f.thread_created_at, from, to)).length;
  const typeCounts = thisWeek.reduce<Record<string, number>>((acc, r) => {
    const t = r.round_type ?? "unknown";
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});

  const week: WeekStat[] = [
    { label: "Pull requests reviewed", value: prCount(thisWeek), previous: prCount(lastWeek), worseWhen: null, format: "count" },
    {
      label: "Rounds",
      value: thisWeek.length,
      previous: lastWeek.length,
      worseWhen: null,
      format: "count",
      note: Object.entries(typeCounts).map(([t, n]) => `${n} ${t}`).join(" · "),
    },
    { label: "Findings posted", value: findingsPosted(weekStart, nowMs + 1), previous: findingsPosted(prevStart, weekStart), worseWhen: null, format: "count" },
    { label: "p95 round time", value: p95(durations(thisWeek)), previous: p95(durations(lastWeek)), worseWhen: "up", format: "duration" },
    { label: "Cache hit", value: cacheHit(thisWeek), previous: cacheHit(lastWeek), worseWhen: "down", format: "percent" },
    { label: "Rounds that failed", value: failedWeek, previous: failedPrev, worseWhen: "up", format: "count" },
  ];

  const openThreadsByRepo = new Map<string, number>();
  for (const row of findings) {
    const fate = decodeFate(row);
    if (fate === "never-answered" || fate === "pushback-open") {
      openThreadsByRepo.set(row.repository, (openThreadsByRepo.get(row.repository) ?? 0) + 1);
    }
  }
  const malformed = new Set((fleet?.malformed_configs ?? []).map((m) => m.repository));
  const repoNames = new Set([...(fleet?.repositories ?? []).map((r) => r.repository), ...reposThisWeek]);
  const repos: RepoLine[] = [...repoNames].map((repository) => {
    const rows = thisWeek.filter((r) => r.repository === repository);
    const denials = rows.reduce((s, r) => s + (r.permission_denials ?? 0), 0);
    const failed = rows.some((r) => r.job_conclusion === "failure");
    const perDay = Array.from({ length: 7 }, (_, i) => {
      const from = weekStart + i * DAY_MS;
      return rows.filter((r) => inWindow(r.recorded_at, from, from + DAY_MS)).length;
    });
    const lastRoundAtRepo = rows.reduce<string | null>((acc, r) => (!acc || r.recorded_at > acc ? r.recorded_at : acc), null)
      ?? fleet?.repositories.find((r) => r.repository === repository)?.last_recorded_at ?? null;
    const state: RepoLine["state"] = failed
      ? "failing"
      : malformed.has(repository)
        ? "config malformed"
        : rows.length > 0 && denials / rows.length >= 2 && denials >= 20
          ? "tool denials"
          : rows.length === 0
            ? "quiet"
            : "healthy";
    return { repository, state, rounds: rows.length, denials, openThreads: openThreadsByRepo.get(repository) ?? 0, lastRoundAt: lastRoundAtRepo, perDay };
  });
  const stateRank: Record<RepoLine["state"], number> = { failing: 0, "config malformed": 1, "tool denials": 2, quiet: 3, healthy: 4 };
  repos.sort((a, b) => stateRank[a.state] - stateRank[b.state] || b.rounds - a.rounds);

  return { problems, lastRoundAt, repositoriesPosting: reposThisWeek.size, needs, anomalies, week, repos };
}
