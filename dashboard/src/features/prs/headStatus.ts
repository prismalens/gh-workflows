import type { RoundRow } from "@/api/types";
import { HEAD_READING_ROUND_TYPES } from "@/honesty/verdict";
import { shortSha } from "@/lib/format";

export type HeadStatusState = "failed" | "did-not-run" | "threads-only" | "reviewed";

export interface HeadStatus {
  state: HeadStatusState;
  label: string;
  sentence: string;
  explain: string;
  headRead: boolean;
  rawVerdict: string | null;
  copyableHint: string | null;
}

/** Attention rank: failed > did-not-run > threads-only > reviewed (#75). */
export const ATTENTION_RANKS: Record<HeadStatusState, number> = {
  failed: 0,
  "did-not-run": 1,
  "threads-only": 2,
  reviewed: 3,
};

function formatRawVerdict(round: RoundRow): string {
  if (round.verdict_text) return round.verdict_text;

  const sha = shortSha(round.head_sha);
  const base = shortSha(round.range_base);
  const inlines = round.inline_count ?? 0;
  const summaries = round.summary_count ?? 0;

  switch (round.verdict_kind) {
    case "reviewed-incremental":
      return `reviewed ${sha} (incremental from ${base}) · ${inlines} inline / ${summaries} summary`;
    case "reviewed":
      return `reviewed ${sha} · ${inlines} inline / ${summaries} summary`;
    case "verify-rechecked":
      return `re-checked open threads at ${sha}`;
    case "auto-paused":
      return `auto-paused: maximum automatic review rounds reached`;
    case "no-token":
      return `skipped execution: no OAuth token reached this lane`;
    case "no-new-commits":
      return `skipped execution: head commit identical to baseline with no new commits`;
    case "silent":
    case "verify-silent":
      return `the lane finished and posted nothing`;
    default:
      if (round.job_conclusion === "failure") return "the review run reported an error";
      if (round.round_type === "verify") return `re-checked open threads at ${sha}`;
      return `reviewed ${sha} · ${inlines} inline / ${summaries} summary`;
  }
}

/**
 * Decodes the head status of a PR from its latest round (#75).
 * A PR whose head was never read (threads-only, did-not-run, silent) must never
 * render as reviewed.
 */
export function decodeHeadStatus(round: RoundRow | undefined): HeadStatus {
  if (!round) {
    return {
      state: "did-not-run",
      label: "did-not-run",
      sentence: "This pull request has no review rounds on record.",
      explain: "The lane has never executed on this pull request.",
      headRead: false,
      rawVerdict: null,
      copyableHint: "@claude review",
    };
  }

  const sha = shortSha(round.head_sha);
  const base = shortSha(round.range_base);
  const rawVerdict = formatRawVerdict(round);

  // 1. Failure / silent cases: head was not reviewed
  if (
    round.verdict_kind === "silent" ||
    round.verdict_kind === "verify-silent" ||
    round.verdict_kind === "error" ||
    round.job_conclusion === "failure"
  ) {
    const isSilent = round.verdict_kind === "silent" || round.verdict_kind === "verify-silent";
    return {
      state: "failed",
      label: isSilent ? "failed: posted nothing" : "failed",
      sentence: `Head ${sha}: not reviewed — the review round ${isSilent ? "finished and posted nothing" : "failed"}.`,
      explain: "The lane finished without posting machine review comments for this head commit.",
      headRead: false,
      rawVerdict,
      copyableHint: "@claude review",
    };
  }

  // 2. Did-not-run cases: head was not reviewed
  if (
    round.verdict_kind === "auto-paused" ||
    round.verdict_kind === "no-token" ||
    round.verdict_kind === "no-new-commits"
  ) {
    if (round.verdict_kind === "auto-paused") {
      const label = round.round_ordinal ? `auto-paused (${round.round_ordinal}/3)` : "auto-paused";
      return {
        state: "did-not-run",
        label,
        sentence: `Head ${sha}: not reviewed — auto-paused after reaching the maximum automatic review rounds.`,
        explain: "Automatic review paused after reaching the round budget.",
        headRead: false,
        rawVerdict,
        copyableHint: "@claude review",
      };
    }
    if (round.verdict_kind === "no-token") {
      return {
        state: "did-not-run",
        label: "no-token",
        sentence: `Head ${sha}: not reviewed — no OAuth token reached this lane.`,
        explain: "Execution skipped because no CLAUDE_CODE_OAUTH_TOKEN reached the action.",
        headRead: false,
        rawVerdict,
        copyableHint: "Configure CLAUDE_CODE_OAUTH_TOKEN secret in repository settings",
      };
    }
    return {
      state: "did-not-run",
      label: "no-new-commits",
      sentence: `Head ${sha}: not reviewed — head commit identical to baseline with no new commits.`,
      explain: "Nothing to re-review because the head SHA has not changed.",
      headRead: false,
      rawVerdict,
      copyableHint: "@claude review",
    };
  }

  // 3. Threads-only: verify round rechecked threads but never read head code
  if (round.verdict_kind === "verify-rechecked" || round.round_type === "verify") {
    return {
      state: "threads-only",
      label: "threads-only",
      sentence: `Head ${sha}: not reviewed — this round only re-checked open threads and did not read head code.`,
      explain: "A verify round evaluates existing review threads without reading the head diff.",
      headRead: false,
      rawVerdict,
      copyableHint: "@claude review",
    };
  }

  // 4. Reviewed: head code was actually read
  if (
    round.verdict_kind === "reviewed" ||
    round.verdict_kind === "reviewed-incremental" ||
    round.verdict_kind === "clean" ||
    (round.round_type && HEAD_READING_ROUND_TYPES.has(round.round_type))
  ) {
    const isIncremental =
      round.verdict_kind === "reviewed-incremental" || round.round_type === "incremental";
    return {
      state: "reviewed",
      label: "reviewed",
      sentence: isIncremental
        ? `Head ${sha}: reviewed (incremental from ${base}) — the lane read this head commit.`
        : `Head ${sha}: reviewed — the lane read this head commit.`,
      explain: "The lane read the head and posted review comments or a clean summary.",
      headRead: true,
      rawVerdict,
      copyableHint: null,
    };
  }

  return {
    state: "did-not-run",
    label: "did-not-run",
    sentence: `Head ${sha}: not reviewed — the round recorded no code review.`,
    explain: "No code-reading review was recorded for this head commit.",
    headRead: false,
    rawVerdict,
    copyableHint: "@claude review",
  };
}
