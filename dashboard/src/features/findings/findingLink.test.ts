import { describe, expect, it } from "vitest";

import type { FindingRow } from "@/api/types";
import { findingGithubLink } from "./FindingsExplorer";

const row = { repository: "o/r", pr_number: 7 } as FindingRow;

describe("findingGithubLink (#185)", () => {
  it("links the thread when the sweep stored its URL on this PR", () => {
    const url = "https://github.com/o/r/pull/7#discussion_r42";
    expect(findingGithubLink({ ...row, thread_url: url })).toEqual({ href: url, label: "Thread on GitHub" });
  });

  it("falls back to the PR's files tab for an old row or a URL that is not this PR's", () => {
    const files = { href: "https://github.com/o/r/pull/7/files", label: "PR files on GitHub" };
    expect(findingGithubLink(row)).toEqual(files);
    expect(findingGithubLink({ ...row, thread_url: "https://github.com/o/r/pull/70#discussion_r1" })).toEqual(files);
    expect(findingGithubLink({ ...row, thread_url: "javascript:alert(1)" })).toEqual(files);
  });
});
