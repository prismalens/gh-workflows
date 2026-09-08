import type { FindingRow } from "@/api/types";
import { derivedMetric, type Metric } from "@/honesty/metrics";

/**
 * Logins that resolve a thread on the lane's own behalf, so a thread they closed
 * is the lane acting on itself, not a human agreeing with it. Kept as a named,
 * versioned constant in dashboard code rather than derived from the App login,
 * because `resolved_by_login` is stored raw on purpose (#111): github-actions[bot]
 * resolves 32% of resolved claude[bot] threads and claude[bot] itself never
 * appears as a resolver. A later fix corrects this list; that re-renders every
 * past finding with no re-sweep, because the raw login is what is stored.
 */
export const WORKFLOW_ACTOR_EXCLUSION_LIST_VERSION = 1;
export const WORKFLOW_ACTOR_LOGINS: ReadonlySet<string> = new Set<string>([
  "github-actions[bot]",
  "claude[bot]",
]);

export function isWorkflowActor(login: string | null): boolean {
  return login !== null && WORKFLOW_ACTOR_LOGINS.has(login);
}

/**
 * The four fates #111 rules, replacing #76's severity column and fuzzy
 * `addressed`/`human-dismissed` chips outright. `self-graded` is deliberately
 * the only fate that can describe a resolved thread with no human on record:
 * the lane resolves its own threads through the workflow token and through its
 * own verify round, and neither is independent confirmation.
 */
export type FindingFate =
  | "never-answered"
  | "pushback-open"
  | "resolved-by-human"
  | "self-graded";

export const FATE_COPY: Record<FindingFate, { label: string; explain: string }> = {
  "never-answered": {
    label: "never answered",
    explain: "No reply on record and the thread is still open.",
  },
  "pushback-open": {
    label: "pushback, open",
    explain: "A human replied, and the thread is still unresolved.",
  },
  "resolved-by-human": {
    label: "resolved by human",
    explain: "A login outside the workflow-actor exclusion list resolved this thread.",
  },
  "self-graded": {
    label: "self-graded",
    explain:
      "The lane's own verify round marked this fixed, a workflow actor resolved the thread, " +
      "or no resolver is on record. This is the lane agreeing with itself, never a measurement " +
      "of whether the finding was actually fixed.",
  },
};

/**
 * Decodes the one fate GitHub and the lane's own verify round agree happened.
 * `self-graded` renders grey everywhere in this feature and must never render
 * green: it is the one fate that can describe a "resolved" thread, and nothing
 * here may present it as a clean result.
 */
export function decodeFate(row: FindingRow): FindingFate {
  const resolved = row.is_resolved === 1;

  if (!resolved) {
    return (row.human_reply_count ?? 0) > 0 ? "pushback-open" : "never-answered";
  }

  // Resolved. Self-graded covers both paths #111 names: the lane's own verify
  // round calling it fixed, and a workflow actor closing the thread. A resolved
  // thread with no resolver on record is also self-graded, never guessed human.
  if (row.verify_verdict === "fixed") return "self-graded";
  if (isWorkflowActor(row.resolved_by_login)) return "self-graded";
  if (row.resolved_by_login) return "resolved-by-human";
  return "self-graded";
}

export interface FixCitation {
  sha: string;
  source: string;
}

/** `fix_sha` null is a named state, never blank, zero or inferred (#111). */
export function fixCitation(row: FindingRow): FixCitation | null {
  if (!row.fix_sha) return null;
  return { sha: row.fix_sha, source: row.fix_sha_source ?? "source not recorded" };
}

/** The fate chip group plus the fix-cited badge, filtered as one chip group (#111 table contract). */
export type FateFilterValue = FindingFate | "fix-cited";

export const FATE_FILTER_OPTIONS: FateFilterValue[] = [
  "never-answered",
  "pushback-open",
  "resolved-by-human",
  "self-graded",
  "fix-cited",
];

export function matchesFateFilter(row: FindingRow, filter: FateFilterValue): boolean {
  if (filter === "fix-cited") return fixCitation(row) !== null;
  return decodeFate(row) === filter;
}

/**
 * Share of findings in the window carrying a `fix_sha`. Denominator is every
 * finding, not only resolved ones, since a fix can land before the thread is
 * marked resolved and #111 asks for a coverage share stated on the tile.
 */
export function preciseAttributionMetric(rows: FindingRow[]): Metric {
  const withFix = rows.filter((row) => fixCitation(row) !== null).length;
  const rate = rows.length === 0 ? null : withFix / rows.length;
  return derivedMetric(rate, rows);
}

export function neverAnsweredFindings(rows: FindingRow[]): FindingRow[] {
  return rows.filter((row) => decodeFate(row) === "never-answered");
}

/**
 * The lane's own verify round saying a fix attempt did not hold. Rendered under
 * a "fix-loop quality" subheading and labelled self-graded, exactly as #47
 * originally filed it: this is the lane grading its own fix, not a measurement.
 */
export function stillAppliesFindings(rows: FindingRow[]): FindingRow[] {
  return rows.filter((row) => row.verify_verdict === "still_applies");
}

/**
 * Where the lane's own verify verdict disagrees with GitHub's real resolved
 * state. Never rendered as an aggregate rate (#111): the lane's own automation
 * can drive resolution through the workflow token, so an agreement rate would
 * be partly mechanical. Disagreement is the one signal that means something
 * regardless of who graded it.
 */
export type DivergenceKind = "verified-fixed-but-open" | "not-addressed-but-resolved";

export const DIVERGENCE_COPY: Record<DivergenceKind, string> = {
  "verified-fixed-but-open":
    "the lane's verify round marked this fixed, but the thread is still open on GitHub",
  "not-addressed-but-resolved":
    "the lane's verify round said the finding still applies, but the thread is resolved on GitHub",
};

export function decodeDivergence(row: FindingRow): DivergenceKind | null {
  const resolved = row.is_resolved === 1;
  if (row.verify_verdict === "fixed" && !resolved) return "verified-fixed-but-open";
  if (row.verify_verdict === "still_applies" && resolved) return "not-addressed-but-resolved";
  return null;
}

export function divergentFindings(rows: FindingRow[]): FindingRow[] {
  return rows.filter((row) => decodeDivergence(row) !== null);
}

/** `repository#pr_number`, the grain findings are attributed at throughout (#111). */
export function prKey(row: FindingRow): string {
  return `${row.repository}#${row.pr_number}`;
}

/**
 * Pull requests whose sweep was cut short by a throttle (#111). Any count drawn
 * from a PR in this set must say so; a count that silently includes a partial
 * sweep is the defect this feature exists to avoid.
 */
export function incompletePrKeys(rows: FindingRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.row_set_incomplete === 1) keys.add(prKey(row));
  }
  return keys;
}

export function matchesFindingSearch(row: FindingRow, needle: string): boolean {
  const lower = needle.toLowerCase();
  return (
    (row.path ?? "").toLowerCase().includes(lower) ||
    (row.header_raw ?? "").toLowerCase().includes(lower) ||
    row.repository.toLowerCase().includes(lower) ||
    String(row.pr_number).includes(lower)
  );
}
