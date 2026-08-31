import type { RoundRow } from "@/api/types";
import { derivedMetric, meanMetric, p95Metric, type Metric } from "./metrics";

export interface RoundAggregates {
  meanWallClock: Metric;
  p95WallClock: Metric;
  denialsPerRound: Metric;
  cacheHitRate: Metric;
  cachingMultiplier: Metric;
}

interface TokenSums {
  input: number;
  read: number;
  create: number;
  contributing: number;
}

function tokenSums(rows: RoundRow[]): TokenSums {
  let input = 0;
  let read = 0;
  let create = 0;
  let contributing = 0;
  for (const row of rows) {
    const rowInput = row.input_tokens;
    const rowRead = row.cache_read_input_tokens;
    const rowCreate = row.cache_creation_input_tokens;
    if (rowInput === null && rowRead === null && rowCreate === null) continue;
    input += rowInput ?? 0;
    read += rowRead ?? 0;
    create += rowCreate ?? 0;
    contributing += 1;
  }
  return { input, read, create, contributing };
}

export function cacheHitRate(rows: RoundRow[]): Metric {
  const { input, read, create, contributing } = tokenSums(rows);
  const total = input + read + create;
  return derivedMetric(total > 0 ? read / total : null, total > 0 ? contributing : 0);
}

/**
 * Uncached-equivalent input over billed-equivalent input, rate-free. An
 * arithmetic identity over the recorded token counts, not an estimate (#46).
 */
export function cachingMultiplier(rows: RoundRow[]): Metric {
  const { input, read, create, contributing } = tokenSums(rows);
  const total = input + read + create;
  const billed = input + 1.25 * create + 0.1 * read;
  return derivedMetric(billed > 0 ? total / billed : null, billed > 0 ? contributing : 0);
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
