import { z } from "zod";

import type { ChangeRow, RoundRow } from "@/api/types";
import { ROLLING_DAYS, ROLLING_ROUNDS } from "./thresholds";

/**
 * Four ranges, fixed. A custom date picker is refused: at roughly seven rounds a
 * day it mostly manufactures empty ranges (#46).
 */
export const RANGE_KEYS = ["rolling", "30d", "90d", "all"] as const;
export type StandardRangeKey = (typeof RANGE_KEYS)[number];
export type MarkerRangeKey = `marker:${string}..${string}`;
export type RangeKey = StandardRangeKey | MarkerRangeKey;

export const DEFAULT_RANGE: RangeKey = "rolling";

export const rangeSchema = z
  .string()
  .refine(isRangeKey)
  .transform((val): RangeKey => val as RangeKey)
  .default(DEFAULT_RANGE)
  .catch(DEFAULT_RANGE);

/**
 * Rejects a marker range. Only the overview fetches `changes` to resolve one;
 * everywhere else falls back to DEFAULT_RANGE rather than an empty page.
 */
export const standardRangeSchema = z
  .string()
  .refine((val): val is StandardRangeKey => (RANGE_KEYS as readonly string[]).includes(val))
  .transform((val): RangeKey => val as RangeKey)
  .default(DEFAULT_RANGE)
  .catch(DEFAULT_RANGE);

export const RANGE_BUTTON_LABELS: Record<StandardRangeKey, string> = {
  rolling: "Rolling",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

export const MARKER_RANGE_PREFIX = "marker:";

export function parseMarkerRange(range: string): { fromId: string; toId: string } | null {
  if (!range.startsWith(MARKER_RANGE_PREFIX)) return null;
  const parts = range.slice(MARKER_RANGE_PREFIX.length).split("..");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { fromId: parts[0], toId: parts[1] };
}

export function isRangeKey(value: unknown): value is RangeKey {
  if (typeof value !== "string") return false;
  if ((RANGE_KEYS as readonly string[]).includes(value)) return true;
  return parseMarkerRange(value) !== null;
}

/** For a link to a route whose search schema rejects marker ranges (#104 finding 1). */
export function linkableRange(range: RangeKey): StandardRangeKey {
  return parseMarkerRange(range) ? (DEFAULT_RANGE as StandardRangeKey) : (range as StandardRangeKey);
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
 *
 * `truncated` says the read route had more rows than one page, in which case the
 * all-time range is not all time and must not claim to be.
 *
 * `changes` allows resolving marker:<a>..<b> across named changes.
 */
export function applyRange(
  rows: RoundRow[],
  range: RangeKey,
  now: Date,
  truncated = false,
  changes?: ChangeRow[],
): ResolvedRange {
  const sorted = [...rows].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));

  const marker = parseMarkerRange(range);
  if (marker) {
    if (!changes) {
      // No changes to resolve against: never fall back to the unfiltered set.
      return {
        rows: [],
        label: `marker range ${marker.fromId}..${marker.toId} (could not be resolved here)`,
      };
    }
    const fromChange = changes.find((c) => c.id === marker.fromId);
    const toChange = changes.find((c) => c.id === marker.toId);
    if (!fromChange || !toChange) {
      return {
        rows: [],
        label: `marker range (unresolved change)`,
      };
    }
    const [early, late] =
      fromChange.at <= toChange.at ? [fromChange, toChange] : [toChange, fromChange];
    const filtered = sorted.filter(
      (row) => row.recorded_at >= early.at && row.recorded_at <= late.at,
    );
    return {
      rows: filtered,
      label: `between "${fromChange.name}" and "${toChange.name}"`,
    };
  }

  if (range === "all") {
    return {
      rows: sorted,
      label: truncated
        ? "the most recent rounds, not all of them"
        : "all recorded rounds",
    };
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
