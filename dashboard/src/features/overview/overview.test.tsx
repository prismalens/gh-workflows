import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RoundRow } from "@/api/types";
import { CountTile } from "@/honesty/Tile";
import { decodeVerdict, verdictMix } from "@/honesty/verdict";
import { makeRounds } from "@/fixtures/rounds";
import { activityBand, roundsPerDay, tokensPerDay, wallClockPoints } from "./activity";
import { attentionCards } from "./attention";

const BASE = makeRounds({ count: 1 })[0];

function round(overrides: Partial<RoundRow>): RoundRow {
  return { ...BASE, ...overrides };
}

describe("the two-state verdict decoding", () => {
  it("claims reviewed only from a round type that reads the head", () => {
    expect(decodeVerdict(round({ round_type: "full" }))).toBe("reviewed");
    expect(decodeVerdict(round({ round_type: "review" }))).toBe("reviewed");
    expect(decodeVerdict(round({ round_type: "incremental" }))).toBe("reviewed");
  });

  it("says unknown for a verify round and for a round with no type", () => {
    // verify reads no code, so calling it reviewed would be a claim about a
    // review that did not happen.
    expect(decodeVerdict(round({ round_type: "verify" }))).toBe("unknown");
    expect(decodeVerdict(round({ round_type: null }))).toBe("unknown");
    expect(decodeVerdict(round({ round_type: "something-later" }))).toBe("unknown");
  });

  it("splits the window into exactly two states that sum to n", () => {
    const rows = makeRounds({ count: 30 });
    const mix = verdictMix(rows);
    expect(mix.reviewed + mix.unknown).toBe(mix.n);
    expect(mix.n).toBe(30);
  });
});

describe("the activity band", () => {
  const rows = [
    round({ session_id: "a", recorded_at: "2026-08-29T01:00:00.000Z", repository: "o/one", pr_number: 1, round_type: "full" }),
    round({ session_id: "b", recorded_at: "2026-08-29T02:00:00.000Z", repository: "o/one", pr_number: 1, round_type: "incremental" }),
    round({ session_id: "c", recorded_at: "2026-08-31T03:00:00.000Z", repository: "o/two", pr_number: 1, round_type: "full" }),
    round({ session_id: "d", recorded_at: "2026-08-31T04:00:00.000Z", repository: "o/two", pr_number: 9, round_type: "verify" }),
    round({ session_id: "e", recorded_at: "2026-08-31T05:00:00.000Z", repository: "o/two", pr_number: 8, round_type: null }),
  ];

  it("counts a pull request once however many rounds read it", () => {
    // Two rounds on o/one#1 are one pull request, and the same number on two
    // repositories is two, because a PR number is only unique within a repo.
    expect(activityBand(rows).prsReviewed).toBe(2);
  });

  it("counts no pull request for a verify round or an untyped one", () => {
    const band = activityBand(rows);
    expect(band.untypedRounds).toBe(1);
    // o/two#9 is verify and o/two#8 is untyped; neither reaches prsReviewed.
    expect(band.prsReviewed).toBe(2);
    expect(band.rounds).toBe(5);
  });

  it("reports the days its rounds actually span, not the nominal range", () => {
    // Aug 29 and Aug 31 are two distinct days, and dividing by 90 would be a lie
    // about a 90-day range holding two.
    expect(activityBand(rows).daysSpanned).toBe(2);
    expect(activityBand(rows).reposActive).toBe(2);
  });

  it("keeps an empty day as a zero bar rather than dropping it", () => {
    const buckets = roundsPerDay(rows, ["full", "incremental", "verify", "untyped"]);
    expect(buckets.map((bucket) => bucket.day)).toEqual([
      "2026-08-29",
      "2026-08-30",
      "2026-08-31",
    ]);
    expect(buckets[1].total).toBe(0);
  });

  it("sums the three input token columns per day", () => {
    const days = tokensPerDay(rows);
    expect(days).toHaveLength(3);
    expect(days[0].input).toBe((rows[0].input_tokens ?? 0) + (rows[1].input_tokens ?? 0));
  });

  it("leaves a round with no wall clock out of the scatter rather than plotting a zero", () => {
    const withNull = [...rows, round({ session_id: "f", duration_ms: null })];
    expect(wallClockPoints(withNull)).toHaveLength(rows.length);
  });
});

describe("the attention feed carries only what the columns support", () => {
  const raw = (extra: Record<string, unknown>) =>
    JSON.stringify({ type: "result", subtype: "success", ...extra });

  it("emits one card per reason, so a round can earn more than one", () => {
    const rows = [
      round({
        session_id: "both",
        permission_denials: 2,
        run_attempt: 3,
        raw_result: raw({ denial_tools: [{ tool: "Bash", count: 2 }] }),
      }),
    ];
    const cards = attentionCards(rows);
    expect(cards.map((card) => card.kind).sort()).toEqual(["denials", "retry"]);
    expect(cards.find((card) => card.kind === "denials")?.detail).toBe("Bash x2");
  });

  it("reads is_error out of raw_result and names the reason it found", () => {
    const rows = [
      round({
        session_id: "err",
        permission_denials: 0,
        run_attempt: 1,
        raw_result: raw({ is_error: true, subtype: "error_during_execution" }),
      }),
    ];
    const cards = attentionCards(rows);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("error");
    expect(cards[0].detail).toContain("error_during_execution");
  });

  it("says the tools are unnamed rather than implying none were denied", () => {
    // parseRawResult degrades an unusable denial list whole, so an absent list
    // must not read as "denials happened and no tool was involved".
    const rows = [
      round({
        session_id: "unnamed",
        permission_denials: 1,
        run_attempt: 1,
        raw_result: raw({ denial_tools: "not-an-array" }),
      }),
    ];
    expect(attentionCards(rows)[0].detail).toMatch(/absent or unreadable/);
  });

  it("emits nothing for a clean round", () => {
    const rows = [
      round({ session_id: "clean", permission_denials: 0, run_attempt: 1, raw_result: raw({}) }),
    ];
    expect(attentionCards(rows)).toEqual([]);
  });
});

describe("a count tile is not an aggregate tile", () => {
  it("renders the count with no n badge, because the count is its own n", () => {
    render(<CountTile label="Review rounds" count={4} detail="2 full · 2 incremental" />);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.queryByTestId("tile-n")).not.toBeInTheDocument();
  });

  it("still refuses a money label", () => {
    expect(() => render(<CountTile label="Total cost (USD)" count={4} />)).toThrow(
      /never a headline tile/,
    );
  });

  it("allows a token count, which is a count and not money", () => {
    expect(() => render(<CountTile label="Billable tokens" count={4} />)).not.toThrow();
  });
});
