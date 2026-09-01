import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import { DenialsPanel, FanOutPanel, RawRecordPanel, TokensPanel } from "./panels";

const BASE = makeRounds({ count: 1 })[0];

function emptyRow(laneVersion: string | null): RoundRow {
  return {
    ...BASE,
    lane_version: laneVersion,
    subagent_stats: null,
    per_model_usage: null,
    raw_result: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  };
}

/** The banner text a reader sees first, not the surrounding cells (#100). */
function banner(what: string): HTMLElement {
  const el = screen.getByText(what).closest('[data-testid="degraded"]');
  if (!el) throw new Error(`no degraded banner found for "${what}"`);
  return el as HTMLElement;
}

describe("degraded banners on a round panel name the reason the row supports (#100)", () => {
  it("an old lane (lane_version below 2): every banner says the lane predates the field", () => {
    const row = emptyRow("v1.9.3");
    render(<FanOutPanel row={row} />);
    render(<TokensPanel row={row} />);
    render(<DenialsPanel row={row} />);
    render(<RawRecordPanel row={row} />);

    for (const what of [
      "Subagent lifecycle counts",
      "Per-model split",
      "Token counts",
      "Which tools were denied",
      "Raw result object",
    ]) {
      const el = banner(what);
      expect(el).toHaveAttribute("data-reason", "lane-did-not-send");
      expect(el.textContent ?? "").toContain("predates the field");
    }
  });

  it("no lane_version recorded: treated the same as an old lane", () => {
    const row = emptyRow(null);
    render(<FanOutPanel row={row} />);
    expect(banner("Subagent lifecycle counts")).toHaveAttribute(
      "data-reason",
      "lane-did-not-send",
    );
  });

  it("a capable lane (lane_version 2 or above): every banner says the round left it out", () => {
    const row = emptyRow("v2.3.1");
    render(<FanOutPanel row={row} />);
    render(<TokensPanel row={row} />);
    render(<DenialsPanel row={row} />);
    render(<RawRecordPanel row={row} />);

    for (const what of [
      "Subagent lifecycle counts",
      "Per-model split",
      "Token counts",
      "Which tools were denied",
      "Raw result object",
    ]) {
      const el = banner(what);
      expect(el).toHaveAttribute("data-reason", "lane-sent-nothing");
      expect(el.textContent ?? "").not.toContain("predates the field");
    }
  });

  it("a garbled subagent_stats blob is unreadable, not a lane-version question", () => {
    // A JSON string that parses but carries no countable field: the "unreadable"
    // branch in blobs.ts, distinct from the column being empty either way.
    const oldLaneRow = { ...emptyRow("v1.0.0"), subagent_stats: JSON.stringify("no data") };
    const newLaneRow = { ...emptyRow("v2.3.1"), subagent_stats: JSON.stringify("no data") };

    render(<FanOutPanel row={oldLaneRow} />);
    expect(banner("Subagent lifecycle counts")).toHaveAttribute("data-reason", "unreadable");

    render(<FanOutPanel row={newLaneRow} />);
    const banners = screen.getAllByText("Subagent lifecycle counts");
    expect(banners).toHaveLength(2);
    for (const text of banners) {
      const el = text.closest('[data-testid="degraded"]');
      expect(el).toHaveAttribute("data-reason", "unreadable");
    }
  });

  it("a fully populated round from a capable lane renders no degraded banner", () => {
    const row: RoundRow = {
      ...BASE,
      lane_version: "v2.3.1",
      subagent_stats: JSON.stringify({ launched: 2, completed: 2 }),
      per_model_usage: JSON.stringify({ "claude-opus-4-6": { inputTokens: 10 } }),
      raw_result: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        denial_tools: [],
      }),
    };
    render(<FanOutPanel row={row} />);
    render(<TokensPanel row={row} />);
    render(<DenialsPanel row={row} />);
    render(<RawRecordPanel row={row} />);

    // "unbuilt" banners (per-agent breakdown, review verdict) are unrelated to #100
    // and still render; none of the six #100 reasons should appear.
    for (const el of screen.getAllByTestId("degraded")) {
      expect(el.getAttribute("data-reason")).toBe("unbuilt");
    }
  });
});
