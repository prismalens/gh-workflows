import type { ChangeRow, RoundRow } from "@/api/types";
import { cacheHitRate, cachingMultiplier } from "@/honesty/aggregate";
import { LOW_N_THRESHOLD, P95_MIN_N } from "@/honesty/thresholds";

export type DeltaColor = "improvement" | "regression" | "neutral" | "uncoloured";

export type MetricComparison =
  | {
      kind: "refused";
      reason: string;
      beforeN: number;
      afterN: number;
    }
  | {
      kind: "compared";
      beforeValue: number;
      afterValue: number;
      beforeN: number;
      afterN: number;
      deltaAbsolute: number;
      deltaPercent: number | null;
      deltaColor: DeltaColor;
      lowN: boolean;
    };

export interface SplitRounds {
  beforeRows: RoundRow[];
  afterRows: RoundRow[];
}

/**
 * Splits rounds across a change's `at` timestamp.
 * Before window: recorded_at < change.at
 * After window:  recorded_at >= change.at
 */
export function splitRoundsByChange(
  rows: RoundRow[],
  change: ChangeRow,
  repositoryFilter?: string,
): SplitRounds {
  let relevant = rows;
  const repo =
    change.scope === "repo" && change.repository ? change.repository : repositoryFilter;
  if (repo) {
    relevant = relevant.filter((r) => r.repository === repo);
  }
  const beforeRows = relevant.filter((r) => r.recorded_at < change.at);
  const afterRows = relevant.filter((r) => r.recorded_at >= change.at);
  return { beforeRows, afterRows };
}

function numeric(values: ReadonlyArray<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * Compares two sets of values for a mean metric (e.g. duration, denials).
 * Refusal 1: Deltas are coloured only when BOTH sides clear n=10.
 */
export function compareMeanMetric(
  beforeValues: ReadonlyArray<number | null | undefined>,
  afterValues: ReadonlyArray<number | null | undefined>,
  higherIsBetter = false,
): MetricComparison {
  const bList = numeric(beforeValues);
  const aList = numeric(afterValues);
  const beforeN = bList.length;
  const afterN = aList.length;

  if (beforeN === 0 || afterN === 0) {
    return {
      kind: "refused",
      reason:
        beforeN === 0 && afterN === 0
          ? "No rounds on either side to compare"
          : beforeN === 0
            ? "No rounds before change to compare"
            : "No rounds after change to compare",
      beforeN,
      afterN,
    };
  }

  const beforeValue = bList.reduce((sum, v) => sum + v, 0) / beforeN;
  const afterValue = aList.reduce((sum, v) => sum + v, 0) / afterN;
  const deltaAbsolute = afterValue - beforeValue;
  const deltaPercent =
    beforeValue !== 0 ? ((afterValue - beforeValue) / Math.abs(beforeValue)) * 100 : null;

  const lowN = beforeN < LOW_N_THRESHOLD || afterN < LOW_N_THRESHOLD;

  let deltaColor: DeltaColor = "uncoloured";
  if (!lowN) {
    if (Math.abs(deltaAbsolute) < 0.00001) {
      deltaColor = "neutral";
    } else if (higherIsBetter) {
      deltaColor = deltaAbsolute > 0 ? "improvement" : "regression";
    } else {
      deltaColor = deltaAbsolute < 0 ? "improvement" : "regression";
    }
  }

  return {
    kind: "compared",
    beforeValue,
    afterValue,
    beforeN,
    afterN,
    deltaAbsolute,
    deltaPercent,
    deltaColor,
    lowN,
  };
}

/**
 * Compares p95 durations.
 * Refusal 2: Below n=20 on EITHER side, the comparison is REFUSED rather than downgraded.
 * The refusal explicitly states which side was short and what its n was.
 */
export function compareP95Metric(
  beforeDurations: ReadonlyArray<number | null | undefined>,
  afterDurations: ReadonlyArray<number | null | undefined>,
): MetricComparison {
  const bList = numeric(beforeDurations).sort((a, b) => a - b);
  const aList = numeric(afterDurations).sort((a, b) => a - b);
  const beforeN = bList.length;
  const afterN = aList.length;

  if (beforeN < P95_MIN_N && afterN < P95_MIN_N) {
    return {
      kind: "refused",
      reason: `p95 comparison refused: before window has n = ${beforeN} and after window has n = ${afterN} (both require n ≥ ${P95_MIN_N})`,
      beforeN,
      afterN,
    };
  }

  if (beforeN < P95_MIN_N) {
    return {
      kind: "refused",
      reason: `p95 comparison refused: before window has n = ${beforeN} (requires n ≥ ${P95_MIN_N})`,
      beforeN,
      afterN,
    };
  }

  if (afterN < P95_MIN_N) {
    return {
      kind: "refused",
      reason: `p95 comparison refused: after window has n = ${afterN} (requires n ≥ ${P95_MIN_N})`,
      beforeN,
      afterN,
    };
  }

  const bIdx = Math.max(0, Math.ceil(beforeN * 0.95) - 1);
  const aIdx = Math.max(0, Math.ceil(afterN * 0.95) - 1);
  const beforeValue = bList[bIdx];
  const afterValue = aList[aIdx];
  const deltaAbsolute = afterValue - beforeValue;
  const deltaPercent =
    beforeValue !== 0 ? ((afterValue - beforeValue) / Math.abs(beforeValue)) * 100 : null;

  // Both are >= 20, which is >= 10, so delta is coloured
  let deltaColor: DeltaColor = "neutral";
  if (Math.abs(deltaAbsolute) < 0.00001) {
    deltaColor = "neutral";
  } else if (deltaAbsolute < 0) {
    deltaColor = "improvement";
  } else {
    deltaColor = "regression";
  }

  return {
    kind: "compared",
    beforeValue,
    afterValue,
    beforeN,
    afterN,
    deltaAbsolute,
    deltaPercent,
    deltaColor,
    lowN: false,
  };
}

/**
 * Compares derived metrics across token sums (cache hit rate, caching multiplier).
 */
export function compareDerivedMetric(
  beforeMetricFn: (rows: RoundRow[]) => { kind: string; value?: number; n: number },
  afterMetricFn: (rows: RoundRow[]) => { kind: string; value?: number; n: number },
  beforeRows: RoundRow[],
  afterRows: RoundRow[],
  higherIsBetter = true,
): MetricComparison {
  const bRes = beforeMetricFn(beforeRows);
  const aRes = afterMetricFn(afterRows);
  const beforeN = bRes.n;
  const afterN = aRes.n;

  if (bRes.kind === "empty" || aRes.kind === "empty" || bRes.value === undefined || aRes.value === undefined) {
    return {
      kind: "refused",
      reason:
        beforeN === 0 && afterN === 0
          ? "No rounds on either side to compare"
          : beforeN === 0
            ? "No rounds before change to compare"
            : "No rounds after change to compare",
      beforeN,
      afterN,
    };
  }

  const beforeValue = bRes.value;
  const afterValue = aRes.value;
  const deltaAbsolute = afterValue - beforeValue;
  const deltaPercent =
    beforeValue !== 0 ? ((afterValue - beforeValue) / Math.abs(beforeValue)) * 100 : null;

  const lowN = beforeN < LOW_N_THRESHOLD || afterN < LOW_N_THRESHOLD;

  let deltaColor: DeltaColor = "uncoloured";
  if (!lowN) {
    if (Math.abs(deltaAbsolute) < 0.00001) {
      deltaColor = "neutral";
    } else if (higherIsBetter) {
      deltaColor = deltaAbsolute > 0 ? "improvement" : "regression";
    } else {
      deltaColor = deltaAbsolute < 0 ? "improvement" : "regression";
    }
  }

  return {
    kind: "compared",
    beforeValue,
    afterValue,
    beforeN,
    afterN,
    deltaAbsolute,
    deltaPercent,
    deltaColor,
    lowN,
  };
}

export interface RoundTypeComparisonResult {
  roundType: string;
  status: "both" | "before-only" | "after-only";
  beforeCount: number;
  afterCount: number;
  beforeRows: RoundRow[];
  afterRows: RoundRow[];
  meanWallClock?: MetricComparison;
  p95WallClock?: MetricComparison;
  cacheHitRate?: MetricComparison;
  cachingMultiplier?: MetricComparison;
  denialsPerRound?: MetricComparison;
  explanation?: string;
}

/**
 * Refusal 3: Round types are compared separately and never pooled.
 * A round type present on only one side is reported rather than compared.
 */
export function compareRoundTypes(
  beforeRows: RoundRow[],
  afterRows: RoundRow[],
): RoundTypeComparisonResult[] {
  const roundTypeSet = new Set<string>();
  for (const r of beforeRows) {
    if (r.round_type) roundTypeSet.add(r.round_type);
  }
  for (const r of afterRows) {
    if (r.round_type) roundTypeSet.add(r.round_type);
  }
  const roundTypes = Array.from(roundTypeSet).sort();

  return roundTypes.map((roundType) => {
    const bRows = beforeRows.filter((r) => r.round_type === roundType);
    const aRows = afterRows.filter((r) => r.round_type === roundType);
    const beforeCount = bRows.length;
    const afterCount = aRows.length;

    if (beforeCount > 0 && afterCount > 0) {
      return {
        roundType,
        status: "both" as const,
        beforeCount,
        afterCount,
        beforeRows: bRows,
        afterRows: aRows,
        meanWallClock: compareMeanMetric(
          bRows.map((r) => r.duration_ms),
          aRows.map((r) => r.duration_ms),
          false,
        ),
        p95WallClock: compareP95Metric(
          bRows.map((r) => r.duration_ms),
          aRows.map((r) => r.duration_ms),
        ),
        cacheHitRate: compareDerivedMetric(
          cacheHitRate,
          cacheHitRate,
          bRows,
          aRows,
          true,
        ),
        cachingMultiplier: compareDerivedMetric(
          cachingMultiplier,
          cachingMultiplier,
          bRows,
          aRows,
          true,
        ),
        denialsPerRound: compareMeanMetric(
          bRows.map((r) => r.permission_denials),
          aRows.map((r) => r.permission_denials),
          false,
        ),
      };
    }

    if (beforeCount > 0 && afterCount === 0) {
      return {
        roundType,
        status: "before-only" as const,
        beforeCount,
        afterCount,
        beforeRows: bRows,
        afterRows: aRows,
        explanation: `Present before change (n = ${beforeCount}), absent after change (n = 0). Round types are never pooled and cannot be compared against an empty window.`,
      };
    }

    return {
      roundType,
      status: "after-only" as const,
      beforeCount,
      afterCount,
      beforeRows: bRows,
      afterRows: aRows,
      explanation: `Present after change (n = ${afterCount}), absent before change (n = 0). Round types are never pooled and cannot be compared against an empty window.`,
    };
  });
}
