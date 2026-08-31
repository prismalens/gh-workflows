import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "@/components/ErrorBoundary";

import { makeRounds } from "@/fixtures/rounds";
import { formatCount, formatDuration } from "@/lib/format";
import type { RoundRow } from "@/api/types";
import { aggregateRounds, cacheHitRate, cachingMultiplier, tokenSums } from "./aggregate";
import { Degraded } from "./Degraded";
import { meanMetric, medianMetric, p95Metric, derivedMetric } from "./metrics";
import { applyRange, RANGE_KEYS, rangeSince } from "./range";
import { RangeControl } from "./RangeControl";
import { aggregateMode, TileStrip } from "./TileStrip";
import { isMoneyLabel, Tile } from "./Tile";
import {
  CACHE_CREATION_WEIGHT,
  CACHE_READ_WEIGHT,
  LIST_RATE_EQUIVALENT,
  LOW_N_THRESHOLD,
  P95_MIN_N,
  ROLLING_ROUNDS,
  TILES_MIN_ROUNDS,
} from "./thresholds";

/** Only the columns the token aggregates read; everything else is irrelevant here. */
function tokenRow(
  input: number | null,
  read: number | null,
  create: number | null,
): RoundRow {
  return {
    ...makeRounds({ count: 1 })[0],
    input_tokens: input,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: create,
  };
}

const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("metrics carry their own honesty state", () => {
  it("reports empty rather than zero when nothing is in range", () => {
    expect(meanMetric([])).toEqual({ kind: "empty", n: 0 });
    expect(p95Metric([null, undefined])).toEqual({ kind: "empty", n: 0 });
    expect(derivedMetric(0.5, [])).toEqual({ kind: "empty", n: 0 });
  });

  it("flags an average computed over fewer than the low-n threshold", () => {
    const under = meanMetric(seq(LOW_N_THRESHOLD - 1));
    const at = meanMetric(seq(LOW_N_THRESHOLD));
    expect(under).toMatchObject({ kind: "value", lowN: true });
    expect(at).toMatchObject({ kind: "value", lowN: false });
  });

  it("substitutes max for p95 below the p95 minimum and says so", () => {
    const under = p95Metric(seq(P95_MIN_N - 1));
    expect(under).toEqual({
      kind: "substituted",
      value: P95_MIN_N - 1,
      n: P95_MIN_N - 1,
      shown: "max",
      suppressed: "p95",
    });

    const at = p95Metric(seq(P95_MIN_N));
    expect(at).toMatchObject({ kind: "value", n: P95_MIN_N });
  });

  it("ignores nulls when counting n", () => {
    expect(medianMetric([1, null, 3, undefined])).toMatchObject({ value: 2, n: 2 });
  });
});

describe("the Tile is the only way to render an aggregate", () => {
  it("always states the round count", () => {
    render(<Tile label="Mean wall clock" metric={meanMetric(seq(30))} format={formatDuration} />);
    expect(screen.getByTestId("tile-n")).toHaveTextContent("n = 30");
  });

  it("labels a substituted p95 as max", () => {
    render(<Tile label="p95 wall clock" metric={p95Metric(seq(5))} format={formatDuration} />);
    expect(screen.getByText("max, not p95")).toBeInTheDocument();
  });

  it("flags a low-n average", () => {
    render(<Tile label="Turns" metric={meanMetric(seq(4))} format={formatCount} />);
    expect(screen.getByText("low n")).toBeInTheDocument();
  });

  it("says no rounds in range rather than showing a zero", () => {
    render(<Tile label="Turns" metric={meanMetric([])} format={formatCount} />);
    expect(screen.getByText("no rounds in range")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("refuses a money label, because cost is a column and never a headline", () => {
    expect(() =>
      render(<Tile label="Total cost (USD)" metric={meanMetric(seq(30))} format={formatCount} />),
    ).toThrow(/never a headline tile/);
  });
});

describe("a thin range renders rows, not aggregates", () => {
  it("switches mode at the ruled threshold", () => {
    expect(aggregateMode(0)).toBe("empty");
    expect(aggregateMode(TILES_MIN_ROUNDS - 1)).toBe("table-instead");
    expect(aggregateMode(TILES_MIN_ROUNDS)).toBe("tiles");
  });

  it("withholds the tiles below the threshold", () => {
    render(
      <TileStrip n={4} windowLabel="the last 7 days">
        <Tile label="Mean wall clock" metric={meanMetric(seq(4))} format={formatDuration} />
      </TileStrip>,
    );
    expect(screen.queryByTestId("tile-n")).not.toBeInTheDocument();
    expect(screen.getByText(/the table below is the summary/)).toBeInTheDocument();
  });

  it("says no rounds in range on an empty window", () => {
    render(<TileStrip n={0} windowLabel="the last 30 days" children={null} />);
    expect(screen.getByText("No rounds in range")).toBeInTheDocument();
  });
});

describe("the range control", () => {
  it("offers exactly four buttons and no date input", () => {
    const { container } = render(<RangeControl value="rolling" onChange={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(RANGE_KEYS).toHaveLength(4);
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });

  it("bounds only the fixed-length ranges server-side", () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    expect(rangeSince("rolling", now)).toBeUndefined();
    expect(rangeSince("all", now)).toBeUndefined();
    expect(rangeSince("30d", now)).toBe("2026-08-01T00:00:00.000Z");
    expect(rangeSince("90d", now)).toBe("2026-06-02T00:00:00.000Z");
  });
});

describe("the rolling window is the larger of 50 rounds and 7 days", () => {
  const now = new Date("2026-08-31T09:00:00.000Z");

  it("takes the round count when the week holds fewer", () => {
    const rows = makeRounds({ count: 64, now });
    const resolved = applyRange(rows, "rolling", now);
    expect(resolved.rows).toHaveLength(ROLLING_ROUNDS);
    expect(resolved.label).toBe(`the last ${ROLLING_ROUNDS} rounds`);
  });

  it("takes the week when it holds more", () => {
    // 200 rounds an hour apart puts far more than 50 inside seven days.
    const rows = makeRounds({ count: 200, now }).map((row, i) => ({
      ...row,
      recorded_at: new Date(now.getTime() - i * 3600 * 1000).toISOString(),
    }));
    const resolved = applyRange(rows, "rolling", now);
    expect(resolved.rows.length).toBeGreaterThan(ROLLING_ROUNDS);
    expect(resolved.label).toBe("the last 7 days");
  });
});

describe("degraded states name their reason", () => {
  it("separates an unbuilt field from one this lane never sent", () => {
    const { rerender } = render(<Degraded what="Review verdict" reason="unbuilt" />);
    expect(screen.getByTestId("degraded")).toHaveAttribute("data-reason", "unbuilt");
    expect(screen.getByText("not collected yet")).toBeInTheDocument();

    rerender(<Degraded what="Fan-out" reason="lane-did-not-send" />);
    expect(screen.getByTestId("degraded")).toHaveAttribute("data-reason", "lane-did-not-send");
    expect(screen.getByText("not sent by this lane")).toBeInTheDocument();
  });
});

describe("the money guard rejects the labels that would defeat it", () => {
  const mustReject = [
    "Total cost (USD)",
    "Total costs",
    "Spending per round",
    "Spent per round",
    "Money per round",
    "Burn per round",
    "Price per round",
    "Pricing",
    "Billed per round",
    "Charge per round",
    "Expense per round",
    "Dollars per round",
    "$ per round",
    "USD",
    LIST_RATE_EQUIVALENT,
  ];

  it.each(mustReject)("refuses %s", (label) => {
    expect(isMoneyLabel(label)).toBe(true);
    expect(() => render(<Tile label={label} metric={meanMetric(seq(30))} format={formatCount} />))
      .toThrow(/never a headline tile/);
  });

  it("still allows the labels this slice actually renders", () => {
    for (const label of [
      "Mean wall clock",
      "p95 wall clock",
      "Permission denials per round",
      "Cache hit rate",
      "Caching multiplier",
    ]) {
      expect(isMoneyLabel(label)).toBe(false);
    }
  });
});

describe("the derived aggregates", () => {
  it("computes the cache hit rate as reads over all input tokens", () => {
    const rows = [tokenRow(1_000, 8_000, 1_000), tokenRow(1_000, 8_000, 1_000)];
    const metric = cacheHitRate(rows);
    // 16000 read / 20000 total
    expect(metric).toMatchObject({ kind: "value", value: 0.8, n: 2, lowN: true });
  });

  it("computes the caching multiplier as the ruled arithmetic identity", () => {
    const rows = [tokenRow(1_000, 8_000, 1_000)];
    const total = 1_000 + 8_000 + 1_000;
    const billed = 1_000 + CACHE_CREATION_WEIGHT * 1_000 + CACHE_READ_WEIGHT * 8_000;
    const metric = cachingMultiplier(rows);
    expect(metric).toMatchObject({ kind: "value", n: 1 });
    if (metric.kind === "value") {
      expect(metric.value).toBeCloseTo(total / billed, 10);
      expect(metric.value).toBeCloseTo(10_000 / 3_050, 10);
    }
  });

  it("drops a round missing any token column rather than summing it as a zero", () => {
    const complete = tokenRow(1_000, 8_000, 1_000);
    const partial = tokenRow(1_000, null, 1_000);

    const sums = tokenSums([complete, partial]);
    expect(sums.contributing).toHaveLength(1);
    expect(sums.read).toBe(8_000);

    // The partial round must not drag the rate down while still counting in n.
    expect(cacheHitRate([complete, partial])).toEqual(cacheHitRate([complete]));
    expect(cacheHitRate([complete, partial])).toMatchObject({ n: 1 });
  });

  it("reports empty rather than zero when no round carries token counts", () => {
    expect(cacheHitRate([tokenRow(null, null, null)])).toEqual({ kind: "empty", n: 0 });
    expect(cachingMultiplier([])).toEqual({ kind: "empty", n: 0 });
  });

  it("ties n to the rows behind the value, not to a caller-supplied count", () => {
    const rows = [tokenRow(1_000, 8_000, 1_000), tokenRow(1_000, null, 1_000)];
    const metric = cacheHitRate(rows);
    expect(metric.n).toBe(tokenSums(rows).contributing.length);
  });

  it("assembles the five tiles the rounds page renders", () => {
    const rows = makeRounds({ count: 25 });
    const stats = aggregateRounds(rows);
    expect(stats.meanWallClock).toMatchObject({ kind: "value", n: 25, lowN: false });
    expect(stats.p95WallClock).toMatchObject({ kind: "value", n: 25 });
    expect(stats.denialsPerRound).toMatchObject({ kind: "value", n: 25 });
    expect(stats.cacheHitRate).toMatchObject({ kind: "value", n: 25 });
    expect(stats.cachingMultiplier).toMatchObject({ kind: "value", n: 25 });
  });

  it("suppresses p95 when the durations behind it are too few, not when the rows are", () => {
    const rows = makeRounds({ count: 25 }).map((row, i) =>
      i < 20 ? { ...row, duration_ms: null } : row,
    );
    expect(aggregateRounds(rows).p95WallClock).toMatchObject({
      kind: "substituted",
      n: 5,
      shown: "max",
    });
  });
});

describe("the all-time range does not overclaim", () => {
  it("says so when the read route truncated the page", () => {
    const rows = makeRounds({ count: 5 });
    expect(applyRange(rows, "all", new Date(), false).label).toBe("all recorded rounds");
    expect(applyRange(rows, "all", new Date(), true).label).toBe(
      "the most recent rounds, not all of them",
    );
  });
});

describe("a violated ruling is visible, not a white screen", () => {
  it("catches the money-label refusal and says what happened", () => {
    // React logs the caught error; silence it so the suite output stays readable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Tile label="Total costs" metric={meanMetric(seq(30))} format={formatCount} />
        </ErrorBoundary>,
      );
      expect(screen.getByText("The dashboard stopped rendering")).toBeInTheDocument();
      expect(screen.getByText(/never a headline tile/)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("renders its children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Tile label="Mean wall clock" metric={meanMetric(seq(30))} format={formatDuration} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("tile-n")).toHaveTextContent("n = 30");
  });
});
