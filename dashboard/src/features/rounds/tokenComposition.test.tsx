import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeRounds } from "@/fixtures/rounds";
import type { RoundRow } from "@/api/types";
import { TokenCompositionBar } from "./TokenCompositionBar";

const BASE = makeRounds({ count: 1 })[0];

describe("TokenCompositionBar (#94)", () => {
  it("the token bar is linear, not log: cache read swamping output by three orders of magnitude is honest", () => {
    // Real round proportions cited in #94 ruling: 55.5M cache read vs 71k output
    const row: RoundRow = {
      ...BASE,
      input_tokens: 10_000,
      cache_creation_input_tokens: 5_000,
      cache_read_input_tokens: 55_500_000,
      output_tokens: 71_000,
    };

    render(<TokenCompositionBar row={row} />);

    const bar = screen.getByTestId("token-composition-bar");
    expect(bar).toHaveAttribute("data-scale", "linear");

    const readSegment = screen.getByTestId("token-bar-cache-read");
    const outputSegment = screen.getByTestId("token-bar-output");
    const inputSegment = screen.getByTestId("token-bar-input");

    const readPct = Number(readSegment.getAttribute("data-pct"));
    const outputPct = Number(outputSegment.getAttribute("data-pct"));
    const inputPct = Number(inputSegment.getAttribute("data-pct"));

    // Linear scale: cache read is ~99.8% of total, output is ~0.13%
    expect(readPct).toBeGreaterThan(99);
    expect(outputPct).toBeLessThan(0.5);
    expect(inputPct).toBeLessThan(0.1);
  });

  it("puts the four raw counts beside the bar", () => {
    const row: RoundRow = {
      ...BASE,
      input_tokens: 12_345,
      cache_creation_input_tokens: 6_789,
      cache_read_input_tokens: 55_500_000,
      output_tokens: 71_234,
    };

    render(<TokenCompositionBar row={row} />);

    const rawCountsContainer = screen.getByTestId("raw-token-counts");
    expect(within(rawCountsContainer).getByText("12,345")).toBeInTheDocument();
    expect(within(rawCountsContainer).getByText("6,789")).toBeInTheDocument();
    expect(within(rawCountsContainer).getByText("55,500,000")).toBeInTheDocument();
    expect(within(rawCountsContainer).getByText("71,234")).toBeInTheDocument();
  });
});
