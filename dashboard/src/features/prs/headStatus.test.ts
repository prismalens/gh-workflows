import { describe, expect, it } from "vitest";

import type { RoundRow } from "@/api/types";
import {
  ATTENTION_RANKS,
  decodeHeadStatus,
} from "./headStatus";
import { comparePRsByAttention, groupRoundsByPR } from "./prs";

function mockRow(overrides: Partial<RoundRow> = {}): RoundRow {
  return {
    session_id: "s-1",
    recorded_at: "2026-08-31T10:00:00.000Z",
    repository: "prismalens/gh-workflows",
    pr_number: 75,
    pr_url: "https://github.com/prismalens/gh-workflows/pull/75",
    head_sha: "abcdef1234567890abcdef1234567890abcdef12",
    run_id: 12345,
    run_attempt: 1,
    run_url: "https://github.com/prismalens/gh-workflows/actions/runs/12345",
    round_type: "full",
    model: "claude-sonnet-4-6",
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 100,
    total_cost_usd: 0.5,
    duration_ms: 60000,
    duration_api_ms: 45000,
    num_turns: 10,
    permission_denials: 0,
    changed_files: 3,
    diff_lines: 40,
    lane_version: "v2.0.0",
    verdict_kind: "reviewed",
    inline_count: 2,
    summary_count: 1,
    round_ordinal: 1,
    fallback_reason: null,
    range_base: null,
    range_head: null,
    model_source: "default",
    job_conclusion: "success",
    pr_title: "PR and detail routes in dashboard",
    pr_author: "sumit",
    pr_state: "open",
    pr_base_ref: "main",
    pr_head_ref: "feat/pr-views",
    ...overrides,
  };
}

describe("head-status decode produces the right label for each of the four states (#75)", () => {
  it("decodes state 1: failed (silent / verify-silent / action error)", () => {
    // Silent round: posted nothing
    const silent = decodeHeadStatus(mockRow({ verdict_kind: "silent" }));
    expect(silent.state).toBe("failed");
    expect(silent.label).toBe("failed: posted nothing");
    expect(silent.headRead).toBe(false);
    expect(silent.sentence).toMatch(/not reviewed/);
    expect(silent.copyableHint).toBe("@claude review");

    // Verify-silent round
    const verifySilent = decodeHeadStatus(mockRow({ verdict_kind: "verify-silent" }));
    expect(verifySilent.state).toBe("failed");
    expect(verifySilent.label).toBe("failed: posted nothing");
    expect(verifySilent.headRead).toBe(false);

    // Job conclusion failure / action error
    const failedJob = decodeHeadStatus(mockRow({ verdict_kind: null, job_conclusion: "failure" }));
    expect(failedJob.state).toBe("failed");
    expect(failedJob.label).toBe("failed");
    expect(failedJob.headRead).toBe(false);
  });

  it("decodes state 2: did-not-run (auto-paused, no-token, no-new-commits)", () => {
    // Auto-paused with round ordinal
    const autoPaused = decodeHeadStatus(
      mockRow({ verdict_kind: "auto-paused", round_ordinal: 3 }),
    );
    expect(autoPaused.state).toBe("did-not-run");
    expect(autoPaused.label).toBe("auto-paused (round 3)");
    expect(autoPaused.headRead).toBe(false);
    expect(autoPaused.sentence).toMatch(/not reviewed/);
    expect(autoPaused.copyableHint).toBe("@claude review");

    // No-token
    const noToken = decodeHeadStatus(mockRow({ verdict_kind: "no-token" }));
    expect(noToken.state).toBe("did-not-run");
    expect(noToken.label).toBe("no-token");
    expect(noToken.headRead).toBe(false);
    expect(noToken.copyableHint).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);

    // No-new-commits
    const noNewCommits = decodeHeadStatus(mockRow({ verdict_kind: "no-new-commits" }));
    expect(noNewCommits.state).toBe("did-not-run");
    expect(noNewCommits.label).toBe("no-new-commits");
    expect(noNewCommits.headRead).toBe(false);
  });

  it("decodes state 3: threads-only (verify round re-checks unresolved threads but never reads head)", () => {
    // Explicit verdict_kind: verify-rechecked
    const rechecked = decodeHeadStatus(
      mockRow({ round_type: "verify", verdict_kind: "verify-rechecked" }),
    );
    expect(rechecked.state).toBe("threads-only");
    expect(rechecked.label).toBe("threads-only");
    expect(rechecked.headRead).toBe(false);
    expect(rechecked.sentence).toMatch(/not reviewed/);
    expect(rechecked.copyableHint).toBe("@claude review");

    // A verify round recorded without verdict_kind must NEVER decode as reviewed (#75)
    const verifyUntyped = decodeHeadStatus(
      mockRow({ round_type: "verify", verdict_kind: null }),
    );
    expect(verifyUntyped.state).toBe("threads-only");
    expect(verifyUntyped.label).toBe("threads-only");
    expect(verifyUntyped.headRead).toBe(false);
  });

  it("decodes state 4: reviewed (full or incremental review reads head code)", () => {
    // Full review
    const full = decodeHeadStatus(
      mockRow({ round_type: "full", verdict_kind: "reviewed" }),
    );
    expect(full.state).toBe("reviewed");
    expect(full.label).toBe("reviewed");
    expect(full.headRead).toBe(true);
    expect(full.sentence).toMatch(/reviewed — the lane read this head commit/);
    expect(full.copyableHint).toBeNull();

    // Incremental review
    const incr = decodeHeadStatus(
      mockRow({
        round_type: "incremental",
        verdict_kind: "reviewed-incremental",
        range_base: "1234567890abcdef1234567890abcdef12345678",
      }),
    );
    expect(incr.state).toBe("reviewed");
    expect(incr.label).toBe("reviewed");
    expect(incr.headRead).toBe(true);
    expect(incr.sentence).toMatch(/reviewed \(incremental from 1234567\)/);
  });
});

describe("the sort order puts unreviewed heads above reviewed-clean ones (#75)", () => {
  it("maintains attention rank: failed > did-not-run > threads-only > reviewed", () => {
    expect(ATTENTION_RANKS.failed).toBeLessThan(ATTENTION_RANKS["did-not-run"]);
    expect(ATTENTION_RANKS["did-not-run"]).toBeLessThan(ATTENTION_RANKS["threads-only"]);
    expect(ATTENTION_RANKS["threads-only"]).toBeLessThan(ATTENTION_RANKS.reviewed);
  });

  it("sorts PRs by attention order: unreviewed heads sort above reviewed-clean", () => {
    const prReviewed = mockRow({
      pr_number: 1,
      verdict_kind: "reviewed",
      recorded_at: "2026-08-31T12:00:00.000Z",
    });
    const prThreadsOnly = mockRow({
      pr_number: 2,
      verdict_kind: "verify-rechecked",
      round_type: "verify",
      recorded_at: "2026-08-31T11:00:00.000Z",
    });
    const prDidNotRun = mockRow({
      pr_number: 3,
      verdict_kind: "auto-paused",
      recorded_at: "2026-08-31T10:00:00.000Z",
    });
    const prFailed = mockRow({
      pr_number: 4,
      verdict_kind: "silent",
      recorded_at: "2026-08-31T09:00:00.000Z",
    });

    const prs = groupRoundsByPR([prReviewed, prThreadsOnly, prDidNotRun, prFailed]);
    prs.sort(comparePRsByAttention);

    expect(prs.map((p) => p.number)).toEqual([4, 3, 2, 1]);
    expect(prs.map((p) => p.headStatus.state)).toEqual([
      "failed",
      "did-not-run",
      "threads-only",
      "reviewed",
    ]);

    // All unreviewed heads appear before reviewed
    const reviewedIndex = prs.findIndex((p) => p.headStatus.state === "reviewed");
    expect(reviewedIndex).toBe(3);
  });
});

describe("unknown verdict kinds default to did-not-run (finding 3943781304)", () => {
  it("an unknown verdict_kind with round_type: 'full' does not render as reviewed", () => {
    const unknownFull = decodeHeadStatus(
      mockRow({ round_type: "full", verdict_kind: "unexpected-future-verdict" }),
    );
    expect(unknownFull.state).toBe("did-not-run");
    expect(unknownFull.headRead).toBe(false);
    expect(unknownFull.rawVerdict).toBe("unrecognized review verdict: unexpected-future-verdict");
  });

  it("an unknown verdict_kind with round_type: 'incremental' does not render as reviewed", () => {
    const unknownIncr = decodeHeadStatus(
      mockRow({ round_type: "incremental", verdict_kind: "experimental-verdict" }),
    );
    expect(unknownIncr.state).toBe("did-not-run");
    expect(unknownIncr.headRead).toBe(false);
    expect(unknownIncr.rawVerdict).toBe("unrecognized review verdict: experimental-verdict");
  });

  it("infers reviewed from round_type only when verdict_kind is absent (null)", () => {
    const absentVerdict = decodeHeadStatus(
      mockRow({ round_type: "full", verdict_kind: null }),
    );
    expect(absentVerdict.state).toBe("reviewed");
    expect(absentVerdict.headRead).toBe(true);
  });
});

