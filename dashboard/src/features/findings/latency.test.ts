import { describe, expect, it } from "vitest";

import type { FindingRow, PrRow } from "@/api/types";
import { reviewToMergeHours, reviewToMergeLatencyMetric } from "./latency";

function finding(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    thread_node_id: "PRRT_1",
    repository: "a/b",
    pr_number: 1,
    path: null,
    original_line: null,
    line: null,
    is_resolved: 0,
    is_outdated: 0,
    resolved_by_login: null,
    thread_created_at: "2026-09-01T00:00:00Z",
    header_raw: null,
    body_excerpt: null,
    diff_hunk: null,
    human_reply_count: 0,
    human_reply_sha: null,
    fix_sha: null,
    fix_sha_source: null,
    verify_verdict: null,
    head_sha_reviewed: null,
    last_swept_at: null,
    row_set_incomplete: 0,
    ...overrides,
  };
}

function pr(overrides: Partial<PrRow> = {}): PrRow {
  return {
    repository: "a/b",
    pr_number: 1,
    state: "merged",
    title: "t",
    author: "alice",
    base_ref: "main",
    head_ref: "feat",
    head_sha: "abc1234",
    merged_at: "2026-09-01T08:00:00Z",
    closed_at: null,
    updated_at: "2026-09-01T08:00:00Z",
    source: "hook",
    ...overrides,
  };
}

describe("reviewToMergeHours", () => {
  it("is null for a PR that is not merged", () => {
    expect(reviewToMergeHours([finding()], pr({ state: "open", merged_at: null }))).toBeNull();
  });

  it("is null when the PR has no findings to measure from", () => {
    expect(reviewToMergeHours([], pr())).toBeNull();
  });

  it("measures from the earliest thread_created_at to merged_at", () => {
    const findings = [
      finding({ thread_created_at: "2026-09-01T04:00:00Z" }),
      finding({ thread_created_at: "2026-09-01T02:00:00Z" }),
    ];
    expect(reviewToMergeHours(findings, pr())).toBe(6);
  });

  it("floors at zero rather than going negative on a same-second race", () => {
    const findings = [finding({ thread_created_at: "2026-09-01T09:00:00Z" })];
    expect(reviewToMergeHours(findings, pr({ merged_at: "2026-09-01T08:00:00Z" }))).toBe(0);
  });

  it("ignores findings from a different pull request", () => {
    const findings = [finding({ pr_number: 999, thread_created_at: "2026-09-01T00:00:00Z" })];
    expect(reviewToMergeHours(findings, pr())).toBeNull();
  });
});

describe("reviewToMergeLatencyMetric", () => {
  it("is empty when no merged PR has a finding", () => {
    expect(reviewToMergeLatencyMetric([], [pr({ state: "open", merged_at: null })])).toEqual({
      kind: "empty",
      n: 0,
    });
  });

  it("takes the median across merged PRs that carry findings", () => {
    const findings = [
      finding({ pr_number: 1, thread_created_at: "2026-09-01T00:00:00Z" }),
      finding({ pr_number: 2, thread_created_at: "2026-09-01T00:00:00Z" }),
    ];
    const prs = [
      pr({ pr_number: 1, merged_at: "2026-09-01T02:00:00Z" }),
      pr({ pr_number: 2, merged_at: "2026-09-01T10:00:00Z" }),
    ];
    const metric = reviewToMergeLatencyMetric(findings, prs);
    expect(metric).toMatchObject({ kind: "value", value: 6, n: 2 });
  });
});
