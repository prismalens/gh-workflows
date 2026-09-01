import type { RoundRow } from "@/api/types";

/**
 * Decodes a round into the four states the lane records, plus `unknown`.
 * `verdict_kind` is the only field that names a state outright. Without it,
 * `reviewed` may be claimed only from a `round_type` naming a code-reading
 * review, and everything else stays `unknown` rather than guessing: a verify
 * round reads no code, and a round recorded without a type says nothing (#46).
 */
export type FourStateVerdict = "reviewed" | "threads-only" | "did-not-run" | "silent";
export type VerdictState = FourStateVerdict | "unknown";

/** The round types under which the lane reads the head. `verify` is not one. */
export const HEAD_READING_ROUND_TYPES: ReadonlySet<string> = new Set([
  "full",
  "review",
  "incremental",
]);

export const VERDICT_KIND_MAP: Record<string, FourStateVerdict> = {
  reviewed: "reviewed",
  "reviewed-incremental": "reviewed",
  "verify-rechecked": "threads-only",
  "auto-paused": "did-not-run",
  "no-token": "did-not-run",
  "no-new-commits": "did-not-run",
  silent: "silent",
  "verify-silent": "silent",
};

export const ALL_VERDICT_KINDS = [
  "reviewed",
  "reviewed-incremental",
  "verify-rechecked",
  "auto-paused",
  "no-token",
  "no-new-commits",
  "silent",
  "verify-silent",
] as const;

export type VerdictKind = (typeof ALL_VERDICT_KINDS)[number];

export const VERDICT_KIND_DEFINITIONS: Record<
  VerdictKind,
  { group: FourStateVerdict; definition: string }
> = {
  reviewed: {
    group: "reviewed",
    definition: "Full review on head commit; posted findings or clean review summary.",
  },
  "reviewed-incremental": {
    group: "reviewed",
    definition: "Incremental review from baseline commit; posted findings or clean summary.",
  },
  "verify-rechecked": {
    group: "threads-only",
    definition: "Re-evaluated unresolved threads; resolved fixed threads or reported status.",
  },
  "auto-paused": {
    group: "did-not-run",
    definition: "Auto-paused after reaching the maximum automatic review rounds.",
  },
  "no-token": {
    group: "did-not-run",
    definition: "No OAuth token reached this lane; skipped execution.",
  },
  "no-new-commits": {
    group: "did-not-run",
    definition: "Head commit identical to baseline with no new commits; nothing to re-review.",
  },
  silent: {
    group: "silent",
    definition: "the lane finished and posted nothing, so the head has no machine review on record",
  },
  "verify-silent": {
    group: "silent",
    definition: "verification round finished but posted nothing, leaving open threads unaddressed",
  },
};

export function decodeVerdict(row: RoundRow): VerdictState {
  if (row.verdict_kind && row.verdict_kind in VERDICT_KIND_MAP) {
    return VERDICT_KIND_MAP[row.verdict_kind];
  }
  return row.round_type !== null && HEAD_READING_ROUND_TYPES.has(row.round_type)
    ? "reviewed"
    : "unknown";
}

export const VERDICT_COPY: Record<VerdictState, { label: string; explain: string }> = {
  reviewed: {
    label: "reviewed",
    explain: "The lane read the head and posted review comments or a clean summary.",
  },
  "threads-only": {
    label: "threads-only",
    explain: "Re-checked unresolved review threads without performing a full head review.",
  },
  "did-not-run": {
    label: "did-not-run",
    explain: "The round did not execute (auto-paused, no token, or no new commits).",
  },
  silent: {
    label: "silent",
    explain: "the lane finished and posted nothing, so the head has no machine review on record",
  },
  unknown: {
    label: "unknown",
    explain:
      "A verify round, which reads no code, or a round recorded without a type. Whether the lane posted anything is not recorded here.",
  },
};

export interface VerdictMix {
  reviewed: number;
  threadsOnly: number;
  didNotRun: number;
  silent: number;
  unknown: number;
  /** Rounds behind the strip, which is every round in the window. */
  n: number;
  [key: string]: number;
}

export function verdictMix(rows: RoundRow[]): VerdictMix {
  let reviewed = 0;
  let threadsOnly = 0;
  let didNotRun = 0;
  let silent = 0;
  let unknown = 0;
  for (const row of rows) {
    const state = decodeVerdict(row);
    if (state === "reviewed") reviewed++;
    else if (state === "threads-only") threadsOnly++;
    else if (state === "did-not-run") didNotRun++;
    else if (state === "silent") silent++;
    else unknown++;
  }
  return {
    reviewed,
    threadsOnly,
    didNotRun,
    silent,
    unknown,
    n: rows.length,
  };
}
