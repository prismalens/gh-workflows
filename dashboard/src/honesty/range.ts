import type { RoundRow } from "@/api/types";
import { ROLLING_DAYS, ROLLING_ROUNDS } from "./thresholds";

/**
 * Four ranges, fixed. A custom date picker is refused: at roughly seven rounds a
 * day it mostly manufactures empty ranges (#46).
 */
export const RANGE_KEYS = ["rolling", "30d", "90d", "all"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const DEFAULT_RANGE: RangeKey = "rolling";

export const RANGE_BUTTON_LABELS: Record<RangeKey, string> = {
  rolling: "Rolling",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The `since` bound to send to GET /api/runs, or undefined for an open range. */
export function rangeSince(range: RangeKey, now: Date): string | undefined {
  if (range === "30d") {
    return new Date(now.getTime() - 30 * DAY_MS).toISOString();
  }
  if (range === "90d") {
    return new Date(now.getTime() - 90 * DAY_MS).toISOString();
  }
  return undefined;
}

export interface ResolvedRange {
  rows: RoundRow[];
  /** Spoken on the tile strip, e.g. "the last 50 rounds". */
  label: string;
}

/**
 * Narrows already-fetched rows to the selected range. The rolling window is the
 * last 50 rounds or 7 days, whichever holds more rounds, and which one won has
 * to reach the label because the two mean different things.
 */
export function applyRange(rows: RoundRow[], range: RangeKey, now: Date): ResolvedRange {
  const sorted = [...rows].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));

  if (range === "all") {
    return { rows: sorted, label: "all recorded rounds" };
  }

  if (range === "30d" || range === "90d") {
    const days = range === "30d" ? 30 : 90;
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    return {
      rows: sorted.filter((row) => row.recorded_at >= cutoff),
      label: `the last ${days} days`,
    };
  }

  const byCount = sorted.slice(0, ROLLING_ROUNDS);
  const cutoff = new Date(now.getTime() - ROLLING_DAYS * DAY_MS).toISOString();
  const byDays = sorted.filter((row) => row.recorded_at >= cutoff);

  return byDays.length >= byCount.length
    ? { rows: byDays, label: `the last ${ROLLING_DAYS} days` }
    : { rows: byCount, label: `the last ${ROLLING_ROUNDS} rounds` };
}
