import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeRounds } from "@/fixtures/rounds";
import { formatCount, formatDuration } from "@/lib/format";
import { Degraded } from "./Degraded";
import { meanMetric, medianMetric, p95Metric, derivedMetric } from "./metrics";
import { applyRange, RANGE_KEYS, rangeSince } from "./range";
import { RangeControl } from "./RangeControl";
import { aggregateMode, TileStrip } from "./TileStrip";
import { Tile } from "./Tile";
import { LOW_N_THRESHOLD, P95_MIN_N, ROLLING_ROUNDS, TILES_MIN_ROUNDS } from "./thresholds";

const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("metrics carry their own honesty state", () => {
  it("reports empty rather than zero when nothing is in range", () => {
    expect(meanMetric([])).toEqual({ kind: "empty", n: 0 });
    expect(p95Metric([null, undefined])).toEqual({ kind: "empty", n: 0 });
    expect(derivedMetric(0.5, 0)).toEqual({ kind: "empty", n: 0 });
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
