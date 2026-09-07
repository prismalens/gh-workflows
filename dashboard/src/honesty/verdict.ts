import type { RoundRow } from "@/api/types";
import { derivedMetric, type Metric } from "./metrics";

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

// `Record<string, VerdictState>` rather than `FourStateVerdict`: `counts-unread` and
// `verify-unread` decode to `unknown`, the existing "can't tell" state, because the round may
// have read the head just fine — only the read-back of what it posted failed. Mapping them to
// `did-not-run` or `silent` would assert an outcome the lane never confirmed. Story: #159.
export const VERDICT_KIND_MAP: Record<string, VerdictState> = {
  reviewed: "reviewed",
  "reviewed-incremental": "reviewed",
  "verify-rechecked": "threads-only",
  "auto-paused": "did-not-run",
  "no-token": "did-not-run",
  "no-new-commits": "did-not-run",
  "paused-by-request": "did-not-run",
  "skipped-trivial": "did-not-run",
  superseded: "did-not-run",
  draft: "did-not-run",
  "verify-superseded": "did-not-run",
  silent: "silent",
  "verify-silent": "silent",
  "verify-cancelled": "silent",
  "counts-unread": "unknown",
  "verify-unread": "unknown",
};

export const ALL_VERDICT_KINDS = [
  "reviewed",
  "reviewed-incremental",
  "verify-rechecked",
  "auto-paused",
  "paused-by-request",
  "skipped-trivial",
  "superseded",
  "draft",
  "no-token",
  "no-new-commits",
  "silent",
  "verify-silent",
  "verify-superseded",
  "verify-cancelled",
  "counts-unread",
  "verify-unread",
] as const;

export type VerdictKind = (typeof ALL_VERDICT_KINDS)[number];

export const VERDICT_KIND_DEFINITIONS: Record<
  VerdictKind,
  { group: VerdictState; definition: string }
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
  "paused-by-request": {
    group: "did-not-run",
    definition: "Paused on purpose with @claude pause; resumes with @claude resume.",
  },
  "skipped-trivial": {
    group: "did-not-run",
    definition: "Diff below the repository's min_diff_lines floor; no review was attempted.",
  },
  superseded: {
    group: "did-not-run",
    definition: "The head moved during the debounce window, so this round would have read a stale diff.",
  },
  draft: {
    group: "did-not-run",
    definition: "The pull request is a draft. Nothing reviews a draft, summons included.",
  },
  "verify-superseded": {
    group: "did-not-run",
    definition:
      "The head moved during the verification round, cancelling it by design before it posted.",
  },
  "verify-cancelled": {
    group: "silent",
    definition:
      "The verification round was cancelled before posting a summary and the cause is not recorded.",
  },
  "no-token": {
    group: "did-not-run",
    definition: "No OAuth token reached this lane; skipped execution.",
  },
  "no-new-commits": {
    group: "did-not-run",
    definition: "Head commit identical to baseline with no new commits; nothing to re-review.",
  },
  "counts-unread": {
    group: "unknown",
    definition:
      "The round finished but the GitHub API would not answer when it tried to count what it posted. Not a report of zero. Read the pull request and the run log.",
  },
  "verify-unread": {
    group: "unknown",
    definition:
      "A verification round finished but the GitHub API would not answer when it tried to read back its own summary comment. Whether threads were re-checked is not recorded here.",
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
    explain:
      "The round did not read the head: paused, below the size floor, superseded, a draft, tokenless, or nothing new to read.",
  },
  silent: {
    label: "silent",
    explain: "the lane finished and posted nothing, so the head has no machine review on record",
  },
  unknown: {
    label: "unknown",
    explain:
      "A verify round, which reads no code; a round recorded without a type; or a round whose " +
      "GitHub API read-back failed after finishing (counts-unread, verify-unread). Whether the " +
      "lane posted anything is not recorded here.",
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

/**
 * The six states the verdict strip and the silent-rate tile decode straight
 * from `verdict_kind`, with no `round_type` fallback: a round with no
 * `verdict_kind` predates the field rather than being an unreadable round
 * type. Kept apart from FourStateVerdict above, which folds in the
 * round_type fallback and stays load-bearing for callers outside this lane
 * (features/failures, features/repos). Issue #141.
 */
export type VerdictKindBucket =
  | "reviewed"
  | "threads-only"
  | "did-not-run"
  | "silent"
  | "error"
  | "unread"
  | "no-verdict-recorded";

/** `clean` is folded into reviewed, matching headStatus.ts's own treatment of it. */
const VERDICT_KIND_BUCKET_MAP: Record<string, VerdictKindBucket> = {
  reviewed: "reviewed",
  "reviewed-incremental": "reviewed",
  clean: "reviewed",
  "verify-rechecked": "threads-only",
  "auto-paused": "did-not-run",
  "paused-by-request": "did-not-run",
  "skipped-trivial": "did-not-run",
  superseded: "did-not-run",
  draft: "did-not-run",
  "verify-superseded": "did-not-run",
  "no-token": "did-not-run",
  "no-new-commits": "did-not-run",
  silent: "silent",
  "verify-silent": "silent",
  "verify-cancelled": "silent",
  error: "error",
  // The round finished; only the read-back of what it posted failed. Bucketing these as
  // `silent` or `error` would assert a result the lane never confirmed. Story: #159.
  "counts-unread": "unread",
  "verify-unread": "unread",
};

export function decodeVerdictKind(row: RoundRow): VerdictKindBucket {
  if (row.verdict_kind === null) return "no-verdict-recorded";
  return VERDICT_KIND_BUCKET_MAP[row.verdict_kind] ?? "error";
}

export const VERDICT_KIND_BUCKET_COPY: Record<
  VerdictKindBucket,
  { label: string; explain: string }
> = {
  reviewed: {
    label: "reviewed",
    explain: "verdict_kind is reviewed, reviewed-incremental, or clean: the lane read the head.",
  },
  "threads-only": {
    label: "threads-only",
    explain: "verdict_kind is verify-rechecked: threads were re-checked without reading the head.",
  },
  "did-not-run": {
    label: "did-not-run",
    explain:
      "verdict_kind names a round that did not read the head: paused, trivial, superseded, draft, tokenless, or no new commits.",
  },
  silent: {
    label: "silent",
    explain: "verdict_kind is silent or verify-silent: the lane finished and posted nothing.",
  },
  error: {
    label: "error",
    explain: "verdict_kind is error: the round failed.",
  },
  unread: {
    label: "unread",
    explain:
      "verdict_kind is counts-unread or verify-unread: the round finished but the GitHub API " +
      "would not confirm what it posted. Not a failure and not silence — read the pull request " +
      "and the run log directly.",
  },
  "no-verdict-recorded": {
    label: "no verdict recorded",
    explain: "verdict_kind is null: this round predates the verdict fields.",
  },
};

export interface VerdictKindMix {
  reviewed: number;
  threadsOnly: number;
  didNotRun: number;
  silent: number;
  error: number;
  unread: number;
  noVerdictRecorded: number;
  n: number;
  [key: string]: number;
}

const VERDICT_KIND_MIX_KEY: Record<VerdictKindBucket, keyof Omit<VerdictKindMix, "n">> = {
  reviewed: "reviewed",
  "threads-only": "threadsOnly",
  "did-not-run": "didNotRun",
  silent: "silent",
  error: "error",
  unread: "unread",
  "no-verdict-recorded": "noVerdictRecorded",
};

export function verdictKindMix(rows: RoundRow[]): VerdictKindMix {
  const mix: VerdictKindMix = {
    reviewed: 0,
    threadsOnly: 0,
    didNotRun: 0,
    silent: 0,
    error: 0,
    unread: 0,
    noVerdictRecorded: 0,
    n: rows.length,
  };
  for (const row of rows) {
    mix[VERDICT_KIND_MIX_KEY[decodeVerdictKind(row)]]++;
  }
  return mix;
}

/**
 * Rounds whose verdict_kind means the lane posted nothing worth reading: the
 * two states features/prs/headStatus.ts:81-86 groups into its "failed" state
 * (silent, verify-silent), plus a hard error. Not imported from there so
 * honesty/ stays free of a features/ dependency; keep the two in step by hand.
 */
function isSilentOrError(bucket: VerdictKindBucket): boolean {
  return bucket === "silent" || bucket === "error";
}

/**
 * Share of rounds in the window that posted nothing, over the rounds that
 * carry a verdict_kind at all. `kind: "empty"` means none of the windowed
 * rows carry a verdict_kind, which the caller must render as a round predating
 * the field rather than as "no rounds in range".
 */
export function silentRateMetric(rows: RoundRow[]): Metric {
  const withVerdict = rows.filter((row) => row.verdict_kind !== null);
  const silentCount = withVerdict.filter((row) => isSilentOrError(decodeVerdictKind(row))).length;
  const rate = withVerdict.length === 0 ? null : silentCount / withVerdict.length;
  return derivedMetric(rate, withVerdict);
}
