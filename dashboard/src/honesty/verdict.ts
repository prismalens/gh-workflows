import type { RoundRow } from "@/api/types";

/**
 * The store holds no verdict column. What the lane posted (reviewed, threads-only,
 * did-not-run, silent) arrives with issue 02, and for any lane older than the
 * Worker it never arrives at all, so this two-state decoding is a permanent state
 * rather than a phase (#46).
 *
 * `reviewed` is claimed only from `round_type`, which is recorded: a round type
 * naming a code-reading review is enough to say the head was read. Everything
 * else says `unknown` rather than guessing, including a verify round, which reads
 * no code, and a round the lane recorded without a type.
 */
export type VerdictState = "reviewed" | "unknown";

/** The round types under which the lane reads the head. `verify` is not one. */
export const HEAD_READING_ROUND_TYPES: ReadonlySet<string> = new Set([
  "full",
  "review",
  "incremental",
]);

export function decodeVerdict(row: RoundRow): VerdictState {
  return row.round_type !== null && HEAD_READING_ROUND_TYPES.has(row.round_type)
    ? "reviewed"
    : "unknown";
}

export const VERDICT_COPY: Record<VerdictState, { label: string; explain: string }> = {
  reviewed: {
    label: "reviewed",
    explain:
      "The round type says the lane read the head. What it then posted is not stored: the verdict column arrives with issue 02.",
  },
  unknown: {
    label: "unknown",
    explain:
      "A verify round, which reads no code, or a round recorded without a type. Whether the lane posted anything is not recorded here.",
  },
};

export interface VerdictMix {
  reviewed: number;
  unknown: number;
  /** Rounds behind the strip, which is every round in the window. */
  n: number;
}

export function verdictMix(rows: RoundRow[]): VerdictMix {
  let reviewed = 0;
  for (const row of rows) {
    if (decodeVerdict(row) === "reviewed") reviewed++;
  }
  return { reviewed, unknown: rows.length - reviewed, n: rows.length };
}
