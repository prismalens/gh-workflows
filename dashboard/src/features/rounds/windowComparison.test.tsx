import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeRounds } from "@/fixtures/rounds";
import type { RoundRow } from "@/api/types";
import { WindowComparisonPanel, WINDOW_DISTRIBUTION_MIN_N } from "./WindowComparisonPanel";

const BASE_ROUNDS = makeRounds({ count: 20 });

describe("WindowComparisonPanel (#94)", () => {
  it("displays the window's n on the panel, not in a tooltip", () => {
    const row = BASE_ROUNDS[0];
    const windowRounds = BASE_ROUNDS.slice(0, 12);

    render(<WindowComparisonPanel row={row} windowRounds={windowRounds} />);

    const badge = screen.getByTestId("window-n");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("n = 12");
  });

  it("the window panel refuses to characterise below the threshold (draws marks, says 'n too small to characterise', and stops)", () => {
    const row = BASE_ROUNDS[0];
    // 6 rounds is below the threshold of 10 (#94 ruling)
    const smallWindow = BASE_ROUNDS.slice(0, 6);
    expect(smallWindow.length).toBeLessThan(WINDOW_DISTRIBUTION_MIN_N);

    render(<WindowComparisonPanel row={row} windowRounds={smallWindow} />);

    // Must draw the marks and highlight this round
    expect(screen.getByTestId("this-round-mark")).toBeInTheDocument();
    const marks = screen.getAllByTestId("window-mark");
    expect(marks.length).toBe(5); // 6 total minus 1 for this round

    // Must say "n too small to characterise"
    const notice = screen.getByTestId("low-n-notice");
    expect(notice).toHaveTextContent("n too small to characterise");

    // Must NOT render percentiles or distribution
    expect(screen.queryByTestId("window-distribution")).not.toBeInTheDocument();
  });

  it("characterises distribution when n is at or above the threshold", () => {
    const row = BASE_ROUNDS[0];
    const largeWindow = BASE_ROUNDS.slice(0, 15);
    expect(largeWindow.length).toBeGreaterThanOrEqual(WINDOW_DISTRIBUTION_MIN_N);

    render(<WindowComparisonPanel row={row} windowRounds={largeWindow} />);

    expect(screen.queryByTestId("low-n-notice")).not.toBeInTheDocument();
    const dist = screen.getByTestId("window-distribution");
    expect(dist).toBeInTheDocument();
    expect(dist).toHaveTextContent("Min");
    expect(dist).toHaveTextContent("Median (p50)");
    expect(dist).toHaveTextContent("p95");
    expect(dist).toHaveTextContent("Max");
  });

  it("the window panel states its variant scope: variant-scoped when variant_key exists", () => {
    const targetKey = "v1a2b3c4d5e6f7";
    const otherKey = "v9z8y7x6w5v4u3";

    const row: RoundRow = {
      ...BASE_ROUNDS[0],
      variant_key: targetKey,
      duration_ms: 120_000,
    };

    const windowRounds: RoundRow[] = [
      row,
      { ...BASE_ROUNDS[1], variant_key: targetKey, duration_ms: 130_000 },
      { ...BASE_ROUNDS[2], variant_key: targetKey, duration_ms: 110_000 },
      { ...BASE_ROUNDS[3], variant_key: otherKey, duration_ms: 300_000 },
      { ...BASE_ROUNDS[4], variant_key: null, duration_ms: 400_000 },
    ];

    render(<WindowComparisonPanel row={row} windowRounds={windowRounds} />);

    const scopeBadge = screen.getByTestId("variant-scope");
    expect(scopeBadge).toHaveTextContent("Variant: v1a2b3c4");

    // Only the 3 rounds with matching variant_key are included in the window
    const nBadge = screen.getByTestId("window-n");
    expect(nBadge).toHaveTextContent("n = 3");
  });

  it("the window panel states its variant scope: mixed window when variant_key is absent", () => {
    const row: RoundRow = {
      ...BASE_ROUNDS[0],
      variant_key: null,
      duration_ms: 120_000,
    };

    const windowRounds: RoundRow[] = BASE_ROUNDS.slice(0, 5).map((r) => ({
      ...r,
      variant_key: null,
    }));

    render(<WindowComparisonPanel row={row} windowRounds={windowRounds} />);

    const scopeBadge = screen.getByTestId("variant-scope");
    expect(scopeBadge).toHaveTextContent("Scope: mixed window");
  });

  it("refuses to characterise when window has >= 10 rows but fewer than 10 valid duration measurements (#94, finding 3944010373)", () => {
    const row: RoundRow = {
      ...BASE_ROUNDS[0],
      duration_ms: 100_000,
    };
    // 12 rows, but only 3 have duration_ms (9 are null)
    const windowRounds: RoundRow[] = [
      row,
      { ...BASE_ROUNDS[1], duration_ms: 110_000 },
      { ...BASE_ROUNDS[2], duration_ms: 120_000 },
      ...BASE_ROUNDS.slice(3, 12).map((r) => ({ ...r, duration_ms: null })),
    ];
    expect(windowRounds.length).toBe(12);

    render(<WindowComparisonPanel row={row} windowRounds={windowRounds} />);

    // Must show n = 12 on badge
    const badge = screen.getByTestId("window-n");
    expect(badge).toHaveTextContent("n = 12");

    // But because valid durations < 10, must NOT characterise distribution
    const notice = screen.getByTestId("low-n-notice");
    expect(notice).toHaveTextContent("n too small to characterise");
    expect(screen.queryByTestId("window-distribution")).not.toBeInTheDocument();
  });
});
