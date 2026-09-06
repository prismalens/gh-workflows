import type { PrRow } from "@/api/types";
import { FIXTURE_ROUNDS } from "./rounds";

/**
 * Prs rows for about half the fixture PRs (#141), so fixture mode exercises both
 * the enriched path and the PR #n / round pr_state fallback in the same table.
 * Title and author deliberately differ from the round snapshot, to prove
 * enrichment replaces them rather than coincidentally matching.
 */
export const FIXTURE_PRS: PrRow[] = FIXTURE_ROUNDS.filter((_, i) => i % 2 === 0).map(
  (round, idx) => {
    const state = idx % 7 === 0 ? "merged" : idx % 11 === 0 ? "closed" : "open";
    return {
      repository: round.repository,
      pr_number: round.pr_number!,
      state,
      title: `${round.pr_title} (current title)`,
      author: `${round.pr_author}-verified`,
      base_ref: round.pr_base_ref,
      head_ref: round.pr_head_ref,
      head_sha: round.head_sha,
      merged_at: state === "merged" ? "2026-08-30T12:00:00.000Z" : null,
      closed_at: state === "closed" ? "2026-08-29T09:00:00.000Z" : null,
      updated_at: round.recorded_at,
      source: "hook",
    };
  },
);
