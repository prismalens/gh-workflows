import type { FindingRow, PrRow } from "@/api/types";
import { medianMetric, type Metric } from "@/honesty/metrics";

/**
 * Hours from the first review comment on a pull request (the earliest
 * `thread_created_at` among its findings) to when it merged. Computed from
 * GitHub timestamps only, floored at zero: one same-second race is on record
 * where a merge event was recorded fractionally before the review timestamp
 * settled, and a negative duration would misstate that as review after merge.
 *
 * This is an attention metric, not a review-quality one (#111): it says how
 * long an open finding sat before merge, not whether the review was any good.
 * A merged PR with no findings at all contributes nothing, because there is no
 * review timestamp to measure from.
 */
export function reviewToMergeHours(findings: FindingRow[], pr: PrRow): number | null {
  if (pr.state !== "merged" || !pr.merged_at) return null;

  const created = findings
    .filter((f) => f.repository === pr.repository && f.pr_number === pr.pr_number)
    .map((f) => f.thread_created_at)
    .filter((iso): iso is string => iso !== null)
    .sort();

  const first = created[0];
  if (!first) return null;

  const firstMs = Date.parse(first);
  const mergedMs = Date.parse(pr.merged_at);
  if (Number.isNaN(firstMs) || Number.isNaN(mergedMs)) return null;

  const hours = (mergedMs - firstMs) / (1000 * 60 * 60);
  return Math.max(0, hours);
}

/**
 * The median tile #111 asks for, over merged pull requests that carry at least
 * one finding. n is merged PRs measured, not finding rows, which is why this
 * takes both tables rather than reusing preciseAttributionMetric's shape.
 */
export function reviewToMergeLatencyMetric(findings: FindingRow[], prs: PrRow[]): Metric {
  const hours = prs
    .map((pr) => reviewToMergeHours(findings, pr))
    .filter((h): h is number => h !== null);
  return medianMetric(hours);
}
