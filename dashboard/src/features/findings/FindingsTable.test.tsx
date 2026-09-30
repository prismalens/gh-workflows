import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FindingRow } from "@/api/types";
import { FindingsTable } from "./FindingsTable";

const row: FindingRow = {
  thread_node_id: "PRRT_1",
  repository: "o/r",
  pr_number: 7,
  path: "a.ts",
  original_line: 3,
  line: 3,
  is_resolved: 0,
  is_outdated: 0,
  resolved_by_login: null,
  thread_created_at: "2026-09-30T00:00:00Z",
  header_raw: null,
  body_excerpt: null,
  human_reply_count: 0,
  human_reply_sha: null,
  fix_sha: null,
  fix_sha_source: null,
  verify_verdict: null,
  head_sha_reviewed: null,
  last_swept_at: "2026-09-30T01:00:00Z",
  row_set_incomplete: 0,
  share_level: "rounds",
};

describe("FindingsTable text tier (#185, #183)", () => {
  it("names the share level where a withheld header and body would be", () => {
    render(<FindingsTable rows={[row]} incompletePrKeys={new Set()} />);
    expect(screen.getAllByTestId("not-shared").map((n) => n.textContent)).toEqual([
      "not collected at share: rounds",
      "not collected at share: rounds",
    ]);
  });

  it("says nothing about share on a row shared in full", () => {
    render(<FindingsTable rows={[{ ...row, share_level: "full" }]} incompletePrKeys={new Set()} />);
    expect(screen.queryByTestId("not-shared")).toBeNull();
  });
});
