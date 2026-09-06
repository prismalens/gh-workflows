import { describe, expect, it } from "vitest";

import type { PrRow, RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import { enrichPRs, filterPRsByState, groupRoundsByPR } from "./prs";

const BASE = makeRounds({ count: 1 })[0];

function round(overrides: Partial<RoundRow>): RoundRow {
  return { ...BASE, ...overrides };
}

function prRow(overrides: Partial<PrRow> & { repository: string; pr_number: number }): PrRow {
  return {
    state: "open",
    title: "current title",
    author: "current-author",
    base_ref: "main",
    head_ref: "feature",
    head_sha: "deadbeef",
    merged_at: null,
    closed_at: null,
    updated_at: "2026-09-01T00:00:00.000Z",
    source: "hook",
    ...overrides,
  };
}

describe("enrichPRs (#136, #141)", () => {
  it("replaces state, title and author when a matching prs row exists", () => {
    const rounds = [
      round({
        session_id: "s-1",
        repository: "a/b",
        pr_number: 1,
        pr_state: "open",
        pr_title: "PR 1",
        pr_author: "round-author",
      }),
    ];
    const prs = groupRoundsByPR(rounds);
    const enriched = enrichPRs(prs, [
      prRow({ repository: "a/b", pr_number: 1, state: "merged", title: "Real title", author: "real-author" }),
    ]);

    expect(enriched[0].state).toBe("merged");
    expect(enriched[0].title).toBe("Real title");
    expect(enriched[0].author).toBe("real-author");
    expect(enriched[0].stateIsFallback).toBe(false);
  });

  it("keeps the round's pr_state and the PR #n fallback when no prs row matches", () => {
    const rounds = [
      round({
        session_id: "s-2",
        repository: "a/b",
        pr_number: 2,
        pr_state: "open",
        pr_title: "",
      }),
    ];
    const prs = groupRoundsByPR(rounds);
    const enriched = enrichPRs(prs, [prRow({ repository: "a/b", pr_number: 999 })]);

    expect(enriched[0].state).toBe("open");
    expect(enriched[0].title).toBe("PR #2");
    expect(enriched[0].stateIsFallback).toBe(true);
  });

  it("drops a prs row whose PR has no round in the base set instead of adding one", () => {
    const rounds = [round({ session_id: "s-3", repository: "a/b", pr_number: 3 })];
    const prs = groupRoundsByPR(rounds);
    const enriched = enrichPRs(prs, [
      prRow({ repository: "a/b", pr_number: 3 }),
      prRow({ repository: "a/b", pr_number: 4 }),
    ]);

    expect(enriched).toHaveLength(1);
    expect(enriched.map((p) => p.number)).toEqual([3]);
  });

  it("the state filter honours the enriched state, not the round's pr_state", () => {
    const rounds = [
      round({ session_id: "s-5", repository: "a/b", pr_number: 5, pr_state: "open" }),
    ];
    const prs = groupRoundsByPR(rounds);
    const enriched = enrichPRs(prs, [prRow({ repository: "a/b", pr_number: 5, state: "merged" })]);

    expect(filterPRsByState(enriched, "merged")).toHaveLength(1);
    expect(filterPRsByState(enriched, "open")).toHaveLength(0);
  });
});
