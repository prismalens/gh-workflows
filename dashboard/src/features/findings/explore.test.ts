import { describe, expect, it } from "vitest";

import type { FindingRow } from "@/api/types";
import {
  ageBucket,
  facetCounts,
  filterFindings,
  sortFindings,
} from "./explore";

const now = new Date("2026-09-24T12:00:00.000Z");

function makeRow(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    thread_node_id: `PRRT_${Math.random().toString(36).slice(2)}`,
    repository: "acme/web",
    pr_number: 1,
    path: "src/index.ts",
    original_line: 10,
    line: 10,
    is_resolved: 0,
    is_outdated: 0,
    resolved_by_login: null,
    thread_created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(), // 2 days old (1d-7d)
    header_raw: "_🎯 Functional Correctness_ | _🟠 Major_\n\nBug description",
    body_excerpt: "Bug description",
    diff_hunk: "@@ -1,1 +1,1 @@",
    human_reply_count: 0,
    human_reply_sha: null,
    fix_sha: null,
    fix_sha_source: null,
    verify_verdict: null,
    head_sha_reviewed: "abc1234",
    last_swept_at: now.toISOString(),
    row_set_incomplete: 0,
    ...overrides,
  };
}

describe("ageBucket boundaries", () => {
  it("classifies days into proper buckets", () => {
    expect(ageBucket(null)).toBeNull();
    expect(ageBucket(0)).toBe("<1d");
    expect(ageBucket(0.99)).toBe("<1d");
    expect(ageBucket(1)).toBe("1d-7d");
    expect(ageBucket(6.99)).toBe("1d-7d");
    expect(ageBucket(7)).toBe("7d-28d");
    expect(ageBucket(27.99)).toBe("7d-28d");
    expect(ageBucket(28)).toBe(">28d");
    expect(ageBucket(100)).toBe(">28d");
  });
});

describe("filterFindings for each filter", () => {
  const prStateMap: Record<string, string> = {
    "acme/web#1": "open",
    "acme/api#2": "closed",
  };
  const prStateOf = (r: FindingRow) => prStateMap[`${r.repository}#${r.pr_number}`];

  const row1 = makeRow({
    thread_node_id: "r1",
    repository: "acme/web",
    pr_number: 1,
    path: "src/frontend/app.tsx",
    is_resolved: 0,
    human_reply_count: 0,
    header_raw: "_🎯 Security_ | _🔴 Critical_\n\nSQL Injection",
    body_excerpt: "SQL Injection",
    thread_created_at: new Date(now.getTime() - 0.5 * 86_400_000).toISOString(), // <1d
  });

  const row2 = makeRow({
    thread_node_id: "r2",
    repository: "acme/api",
    pr_number: 2,
    path: "src/backend/db.go",
    is_resolved: 1,
    resolved_by_login: "alice",
    fix_sha: "beef123",
    header_raw: "_🎯 Performance_ | _🟡 Minor_\n\nN+1 query",
    body_excerpt: "N+1 query",
    thread_created_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(), // 7d-28d
  });

  const rows = [row1, row2];

  it("filters by repository", () => {
    expect(filterFindings(rows, { repository: "web" }, prStateOf, now)).toEqual([row1]);
    expect(filterFindings(rows, { repository: "api" }, prStateOf, now)).toEqual([row2]);
  });

  it("filters by fate", () => {
    expect(filterFindings(rows, { fate: "never-answered" }, prStateOf, now)).toEqual([row1]);
    expect(filterFindings(rows, { fate: "resolved-by-human" }, prStateOf, now)).toEqual([row2]);
    expect(filterFindings(rows, { fate: "fix-cited" }, prStateOf, now)).toEqual([row2]);
  });

  it("filters by prState", () => {
    expect(filterFindings(rows, { prState: "open" }, prStateOf, now)).toEqual([row1]);
    expect(filterFindings(rows, { prState: "closed" }, prStateOf, now)).toEqual([row2]);
    expect(filterFindings(rows, { prState: "all" }, prStateOf, now)).toEqual(rows);
  });

  it("filters by path", () => {
    expect(filterFindings(rows, { path: "frontend" }, prStateOf, now)).toEqual([row1]);
    expect(filterFindings(rows, { path: "backend" }, prStateOf, now)).toEqual([row2]);
  });

  it("filters by age", () => {
    expect(filterFindings(rows, { age: "<1d" }, prStateOf, now)).toEqual([row1]);
    expect(filterFindings(rows, { age: "7d-28d" }, prStateOf, now)).toEqual([row2]);
    expect(filterFindings(rows, { age: ">7d" }, prStateOf, now)).toEqual([row2]);
  });

  it("filters by sev", () => {
    expect(filterFindings(rows, { sev: "critical" }, prStateOf, now)).toEqual([row1]);
    expect(filterFindings(rows, { sev: "minor" }, prStateOf, now)).toEqual([row2]);
  });

  it("filters by pr", () => {
    expect(filterFindings(rows, { pr: "1" }, prStateOf, now)).toEqual([row1]);
    expect(filterFindings(rows, { pr: "#2" }, prStateOf, now)).toEqual([row2]);
  });

  it("filters by q (free text search)", () => {
    expect(filterFindings(rows, { q: "injection" }, prStateOf, now)).toEqual([row1]);
    expect(filterFindings(rows, { q: "n+1" }, prStateOf, now)).toEqual([row2]);
  });

  it("respects the skip parameter", () => {
    // When skipping repository, the repository filter is ignored
    expect(filterFindings(rows, { repository: "web" }, prStateOf, now, "repository")).toEqual(rows);
    // When skipping fate, the fate filter is ignored
    expect(filterFindings(rows, { fate: "never-answered" }, prStateOf, now, "fate")).toEqual(rows);
    // Other filters still apply when skip is present
    expect(filterFindings(rows, { repository: "web", sev: "critical" }, prStateOf, now, "repository")).toEqual([row1]);
  });
});

describe("facetCounts", () => {
  it("counts options the OTHER filters leave", () => {
    const prStateOf = () => "open";
    const rowA = makeRow({
      repository: "acme/alpha",
      is_resolved: 0,
      human_reply_count: 0,
      header_raw: "_🎯 Bug_ | _🔴 Critical_",
    });
    const rowB = makeRow({
      repository: "acme/beta",
      is_resolved: 0,
      human_reply_count: 0,
      header_raw: "_🎯 Bug_ | _🟡 Minor_",
    });

    const rows = [rowA, rowB];

    // Filter by repository: acme/alpha
    const counts = facetCounts(rows, { repository: "acme/alpha" }, prStateOf, now);

    // Repository facet skips repository filter, so both repositories are counted
    expect(counts.repository["acme/alpha"]).toBe(1);
    expect(counts.repository["acme/beta"]).toBe(1);

    // But severity facet applies repository: acme/alpha, so only rowA is counted
    expect(counts.sev.critical).toBe(1);
    expect(counts.sev.minor).toBeUndefined();
  });
});

describe("sortFindings both directions", () => {
  const rowOld = makeRow({
    thread_node_id: "old",
    thread_created_at: "2026-09-01T00:00:00.000Z",
  });
  const rowNew = makeRow({
    thread_node_id: "new",
    thread_created_at: "2026-09-20T00:00:00.000Z",
  });

  it("sorts oldest first", () => {
    const sorted = sortFindings([rowNew, rowOld], "oldest");
    expect(sorted.map((r) => r.thread_node_id)).toEqual(["old", "new"]);
  });

  it("sorts newest first", () => {
    const sorted = sortFindings([rowOld, rowNew], "newest");
    expect(sorted.map((r) => r.thread_node_id)).toEqual(["new", "old"]);
  });
});
