import { describe, expect, it } from "vitest";

import type { FindingRow } from "@/api/types";
import {
  decodeDivergence,
  decodeFate,
  divergentFindings,
  fixCitation,
  incompletePrKeys,
  isWorkflowActor,
  matchesFateFilter,
  matchesFindingSearch,
  neverAnsweredFindings,
  preciseAttributionMetric,
  prKey,
  stillAppliesFindings,
  WORKFLOW_ACTOR_LOGINS,
} from "./findings";

function row(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    thread_node_id: "PRRT_1",
    repository: "prismalens/gh-workflows",
    pr_number: 111,
    path: "worker/index.js",
    original_line: 10,
    line: 10,
    is_resolved: 0,
    is_outdated: 0,
    resolved_by_login: null,
    thread_created_at: "2026-09-01T00:00:00Z",
    header_raw: "Bug",
    body_excerpt: "This looks off.",
    diff_hunk: "@@ -1,3 +1,3 @@",
    human_reply_count: 0,
    human_reply_sha: null,
    fix_sha: null,
    fix_sha_source: null,
    verify_verdict: null,
    head_sha_reviewed: "abc1234",
    last_swept_at: "2026-09-01T01:00:00Z",
    row_set_incomplete: 0,
    ...overrides,
  };
}

describe("isWorkflowActor", () => {
  it("names github-actions[bot] and claude[bot] as workflow actors", () => {
    expect(WORKFLOW_ACTOR_LOGINS.has("github-actions[bot]")).toBe(true);
    expect(WORKFLOW_ACTOR_LOGINS.has("claude[bot]")).toBe(true);
    expect(isWorkflowActor("github-actions[bot]")).toBe(true);
    expect(isWorkflowActor("alice")).toBe(false);
    expect(isWorkflowActor(null)).toBe(false);
  });
});

describe("decodeFate", () => {
  it("is never-answered when unresolved with no human reply", () => {
    expect(decodeFate(row({ is_resolved: 0, human_reply_count: 0 }))).toBe("never-answered");
  });

  it("is pushback-open when unresolved but a human replied", () => {
    expect(decodeFate(row({ is_resolved: 0, human_reply_count: 2 }))).toBe("pushback-open");
  });

  it("is resolved-by-human when a non-workflow login resolved it", () => {
    expect(decodeFate(row({ is_resolved: 1, resolved_by_login: "alice" }))).toBe(
      "resolved-by-human",
    );
  });

  it("is self-graded when a workflow actor resolved it, never resolved-by-human", () => {
    expect(
      decodeFate(row({ is_resolved: 1, resolved_by_login: "github-actions[bot]" })),
    ).toBe("self-graded");
    expect(decodeFate(row({ is_resolved: 1, resolved_by_login: "claude[bot]" }))).toBe(
      "self-graded",
    );
  });

  it("is self-graded when the lane's own verify round says fixed, even with a human resolver", () => {
    expect(
      decodeFate(row({ is_resolved: 1, resolved_by_login: "alice", verify_verdict: "fixed" })),
    ).toBe("self-graded");
  });

  it("is self-graded rather than guessed-human when resolved with no resolver on record", () => {
    expect(decodeFate(row({ is_resolved: 1, resolved_by_login: null }))).toBe("self-graded");
  });
});

describe("fixCitation", () => {
  it("is null, not blank or zero, when fix_sha is absent", () => {
    expect(fixCitation(row({ fix_sha: null }))).toBeNull();
  });

  it("carries the sha and its source when present", () => {
    expect(fixCitation(row({ fix_sha: "abc1234", fix_sha_source: "verify_table" }))).toEqual({
      sha: "abc1234",
      source: "verify_table",
    });
  });

  it("names the source as not recorded rather than inferring one", () => {
    expect(fixCitation(row({ fix_sha: "abc1234", fix_sha_source: null }))).toEqual({
      sha: "abc1234",
      source: "source not recorded",
    });
  });
});

describe("matchesFateFilter", () => {
  it("matches fix-cited independently of fate", () => {
    const withFix = row({ fix_sha: "abc1234", is_resolved: 0 });
    const withoutFix = row({ fix_sha: null, is_resolved: 0 });
    expect(matchesFateFilter(withFix, "fix-cited")).toBe(true);
    expect(matchesFateFilter(withoutFix, "fix-cited")).toBe(false);
  });

  it("matches a fate value against decodeFate", () => {
    expect(matchesFateFilter(row({ is_resolved: 0 }), "never-answered")).toBe(true);
    expect(matchesFateFilter(row({ is_resolved: 0 }), "self-graded")).toBe(false);
  });
});

describe("preciseAttributionMetric", () => {
  it("is empty over zero findings", () => {
    expect(preciseAttributionMetric([])).toEqual({ kind: "empty", n: 0 });
  });

  it("is the share of findings carrying a fix_sha, over every finding not only resolved ones", () => {
    const rows = [
      row({ fix_sha: "a", is_resolved: 1 }),
      row({ fix_sha: null, is_resolved: 0 }),
      row({ fix_sha: null, is_resolved: 0 }),
      row({ fix_sha: null, is_resolved: 0 }),
    ];
    const metric = preciseAttributionMetric(rows);
    expect(metric).toMatchObject({ kind: "value", value: 0.25, n: 4 });
  });
});

describe("neverAnsweredFindings", () => {
  it("counts only the never-answered fate", () => {
    const rows = [
      row({ is_resolved: 0, human_reply_count: 0 }),
      row({ is_resolved: 0, human_reply_count: 1 }),
      row({ is_resolved: 1, resolved_by_login: "alice" }),
    ];
    expect(neverAnsweredFindings(rows)).toHaveLength(1);
  });
});

describe("stillAppliesFindings", () => {
  it("is the lane's own verify round saying a fix did not hold, labelled self-graded by the caller", () => {
    const rows = [
      row({ verify_verdict: "still_applies" }),
      row({ verify_verdict: "fixed" }),
      row({ verify_verdict: null }),
    ];
    expect(stillAppliesFindings(rows)).toHaveLength(1);
  });
});

describe("decodeDivergence and divergentFindings", () => {
  it("flags verified-fixed-but-open", () => {
    const r = row({ verify_verdict: "fixed", is_resolved: 0 });
    expect(decodeDivergence(r)).toBe("verified-fixed-but-open");
  });

  it("flags not-addressed-but-resolved", () => {
    const r = row({ verify_verdict: "still_applies", is_resolved: 1 });
    expect(decodeDivergence(r)).toBe("not-addressed-but-resolved");
  });

  it("is null when the verdict and GitHub state agree", () => {
    expect(decodeDivergence(row({ verify_verdict: "fixed", is_resolved: 1 }))).toBeNull();
    expect(
      decodeDivergence(row({ verify_verdict: "still_applies", is_resolved: 0 })),
    ).toBeNull();
    expect(decodeDivergence(row({ verify_verdict: null, is_resolved: 0 }))).toBeNull();
  });

  it("divergentFindings filters to only the disagreeing rows", () => {
    const rows = [
      row({ verify_verdict: "fixed", is_resolved: 0 }),
      row({ verify_verdict: "still_applies", is_resolved: 1 }),
      row({ verify_verdict: "fixed", is_resolved: 1 }),
    ];
    expect(divergentFindings(rows)).toHaveLength(2);
  });
});

describe("incompletePrKeys and prKey", () => {
  it("keys a row by repository#pr_number", () => {
    expect(prKey(row({ repository: "a/b", pr_number: 5 }))).toBe("a/b#5");
  });

  it("collects only PRs whose sweep was cut short", () => {
    const rows = [
      row({ repository: "a/b", pr_number: 1, row_set_incomplete: 1 }),
      row({ repository: "a/b", pr_number: 2, row_set_incomplete: 0 }),
    ];
    expect(incompletePrKeys(rows)).toEqual(new Set(["a/b#1"]));
  });
});

describe("matchesFindingSearch", () => {
  it("matches on path, header, repository and pr number, case-insensitively", () => {
    const r = row({ path: "worker/Index.js", header_raw: "Null pointer", repository: "a/b", pr_number: 42 });
    expect(matchesFindingSearch(r, "index.js")).toBe(true);
    expect(matchesFindingSearch(r, "null pointer")).toBe(true);
    expect(matchesFindingSearch(r, "a/b")).toBe(true);
    expect(matchesFindingSearch(r, "42")).toBe(true);
    expect(matchesFindingSearch(r, "nope")).toBe(false);
  });
});
