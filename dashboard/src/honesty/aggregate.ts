import type { RoundRow } from "@/api/types";
import { derivedMetric, meanMetric, p95Metric, type Metric } from "./metrics";
import { CACHE_CREATION_WEIGHT, CACHE_READ_WEIGHT } from "./thresholds";

export interface RoundAggregates {
  meanWallClock: Metric;
  p95WallClock: Metric;
  denialsPerRound: Metric;
  cacheHitRate: Metric;
  cachingMultiplier: Metric;
}

export interface TokenSums {
  input: number;
  read: number;
  create: number;
  /**
   * Only the rounds carrying all three counts. A round missing one would
   * otherwise be summed as a zero, which reads as "this round used no cache"
   * while still counting towards n.
   */
  contributing: RoundRow[];
}

export function tokenSums(rows: RoundRow[]): TokenSums {
  let input = 0;
  let read = 0;
  let create = 0;
  const contributing: RoundRow[] = [];

  for (const row of rows) {
    if (
      row.input_tokens === null ||
      row.cache_read_input_tokens === null ||
      row.cache_creation_input_tokens === null
    ) {
      continue;
    }
    input += row.input_tokens;
    read += row.cache_read_input_tokens;
    create += row.cache_creation_input_tokens;
    contributing.push(row);
  }

  return { input, read, create, contributing };
}

export function cacheHitRate(rows: RoundRow[]): Metric {
  const { input, read, create, contributing } = tokenSums(rows);
  const total = input + read + create;
  return derivedMetric(total > 0 ? read / total : null, contributing);
}

/**
 * Uncached-equivalent input over billed-equivalent input, rate-free. An
 * arithmetic identity over the recorded token counts, not an estimate (#46).
 */
export function cachingMultiplier(rows: RoundRow[]): Metric {
  const { input, read, create, contributing } = tokenSums(rows);
  const total = input + read + create;
  const billed = input + CACHE_CREATION_WEIGHT * create + CACHE_READ_WEIGHT * read;
  return derivedMetric(billed > 0 ? total / billed : null, contributing);
}

export function aggregateRounds(rows: RoundRow[]): RoundAggregates {
  const durations = rows.map((row) => row.duration_ms);
  return {
    meanWallClock: meanMetric(durations),
    p95WallClock: p95Metric(durations),
    denialsPerRound: meanMetric(rows.map((row) => row.permission_denials)),
    cacheHitRate: cacheHitRate(rows),
    cachingMultiplier: cachingMultiplier(rows),
  };
}
