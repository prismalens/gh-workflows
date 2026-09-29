import { describe, expect, it } from "vitest";

import type { RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import { searchAll, type SearchSources } from "./searchIndex";

const baseRound = makeRounds({ count: 1 })[0]!;

function makeRound(overrides: Partial<RoundRow> = {}): RoundRow {
  return {
    ...baseRound,
    session_id: `s-${Math.random().toString(36).slice(2)}`,
    repository: "acme/web",
    pr_number: 1,
    pr_title: "Test PR",
    pr_author: "alice",
    pr_state: "open",
    head_sha: "abcdef1234567890",
    round_type: "review",
    verdict_kind: "reviewed",
    job_conclusion: "success",
    recorded_at: "2026-09-24T10:00:00.000Z",
    permission_denials: 0,
    duration_ms: 60_000,
    input_tokens: 1000,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 500,
    total_cost_usd: 0.05,
    round_ordinal: 1,
    run_id: 100,
    run_attempt: 1,
    ...overrides,
  };
}

describe("searchAll", () => {
  const r12 = makeRound({
    repository: "owner/repo",
    pr_number: 12,
    pr_title: "Add awesome feature",
    head_sha: "1234567abcdef890",
  });
  const r99 = makeRound({
    repository: "other/repo",
    pr_number: 99,
    pr_title: "Fix bug 12 in other repo",
    head_sha: "fedcba9876543210",
  });
  const rSha = makeRound({
    session_id: "round-target-sha",
    repository: "owner/repo",
    pr_number: 55,
    head_sha: "a1b2c3d4e5f67890",
  });

  const src: SearchSources = {
    rounds: [r12, r99, rSha],
    findings: [],
    repositories: ["owner/repo", "other/repo"],
  };

  it("owner/repo#12 ranks that PR first", () => {
    const results = searchAll("owner/repo#12", src);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      kind: "pull request",
      target: {
        to: "/prs/$owner/$repo/$number",
        params: { owner: "owner", repo: "repo", number: "12" },
      },
      score: 100,
    });
  });

  it("#12 finds PR 12", () => {
    const results = searchAll("#12", src);
    const prResult = results.find(
      (r) =>
        r.kind === "pull request" &&
        r.target.to === "/prs/$owner/$repo/$number" &&
        "params" in r.target &&
        r.target.params.number === "12",
    );
    expect(prResult).toBeDefined();
  });

  it("a 7-char sha prefix finds the round", () => {
    const results = searchAll("a1b2c3d", src);
    const roundResult = results.find(
      (r) =>
        r.kind === "round" &&
        r.target.to === "/rounds/$sessionId" &&
        "params" in r.target &&
        r.target.params.sessionId === "round-target-sha",
    );
    expect(roundResult).toBeDefined();
  });

  it("repo:acme yields a filter result targeting /findings with search {repository: 'acme'}", () => {
    const results = searchAll("repo:acme", src);
    const filterResult = results.find((r) => r.kind === "filter");
    expect(filterResult).toBeDefined();
    expect(filterResult).toMatchObject({
      kind: "filter",
      title: "repo:acme",
      target: {
        to: "/findings",
        search: { repository: "acme" },
      },
    });
  });

  it("empty query returns the pages", () => {
    const results = searchAll("", src);
    expect(results.every((r) => r.kind === "page")).toBe(true);
    const titles = results.map((r) => r.title);
    expect(titles).toEqual([
      "Home",
      "Inbox",
      "Fleet",
      "Repos",
      "Rounds",
      "Pull requests",
    ]);
  });
});
