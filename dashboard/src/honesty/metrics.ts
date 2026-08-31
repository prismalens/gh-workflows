import { LOW_N_THRESHOLD, P95_MIN_N } from "./thresholds";

/**
 * A Metric carries its own honesty state, so a tile cannot render a number
 * without also rendering the round count and any flag that number earned.
 * There is deliberately no way to build one from a bare number and no n.
 */
export type Metric =
  | { kind: "empty"; n: 0 }
  | { kind: "value"; value: number; n: number; lowN: boolean }
  | { kind: "substituted"; value: number; n: number; shown: "max"; suppressed: "p95" };

const EMPTY: Metric = { kind: "empty", n: 0 };

export function numeric(values: ReadonlyArray<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function meanMetric(values: ReadonlyArray<number | null | undefined>): Metric {
  const present = numeric(values);
  if (present.length === 0) {
    return EMPTY;
  }
  const total = present.reduce((sum, v) => sum + v, 0);
  return {
    kind: "value",
    value: total / present.length,
    n: present.length,
    lowN: present.length < LOW_N_THRESHOLD,
  };
}

export function medianMetric(values: ReadonlyArray<number | null | undefined>): Metric {
  const present = numeric(values).sort((a, b) => a - b);
  if (present.length === 0) {
    return EMPTY;
  }
  const mid = Math.floor(present.length / 2);
  const value =
    present.length % 2 === 0 ? (present[mid - 1] + present[mid]) / 2 : present[mid];
  return { kind: "value", value, n: present.length, lowN: present.length < LOW_N_THRESHOLD };
}

/**
 * Below P95_MIN_N observations this returns the max instead, tagged so the tile
 * says so. It never returns a p95 the sample cannot support.
 */
export function p95Metric(values: ReadonlyArray<number | null | undefined>): Metric {
  const present = numeric(values).sort((a, b) => a - b);
  if (present.length === 0) {
    return EMPTY;
  }
  if (present.length < P95_MIN_N) {
    return {
      kind: "substituted",
      value: present[present.length - 1],
      n: present.length,
      shown: "max",
      suppressed: "p95",
    };
  }
  const index = Math.max(0, Math.ceil(present.length * 0.95) - 1);
  return { kind: "value", value: present[index], n: present.length, lowN: false };
}

/**
 * For a figure computed from sums across rounds rather than an average of
 * per-round values: cache hit rate, the caching multiplier. It takes the rounds
 * that contributed rather than a count, so n cannot drift away from the data the
 * value was computed from.
 */
export function derivedMetric(
  value: number | null,
  contributing: ReadonlyArray<unknown>,
): Metric {
  const n = contributing.length;
  if (n === 0 || value === null || !Number.isFinite(value)) {
    return EMPTY;
  }
  return { kind: "value", value, n, lowN: n < LOW_N_THRESHOLD };
}

export function isEmpty(metric: Metric): metric is { kind: "empty"; n: 0 } {
  return metric.kind === "empty";
}
