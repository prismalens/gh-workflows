import type { ChangeRow, RoundRow } from "@/api/types";
import { localDay } from "@/lib/format";
import { parseMarkerRange, type RangeKey } from "@/honesty/range";
import { ROLLING_DAYS, ROLLING_ROUNDS } from "@/honesty/thresholds";
import { decodeVerdict, type VerdictState } from "@/honesty/verdict";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TypeCount {
  type: string;
  rounds: number;
}

export interface ActivityBand {
  rounds: number;
  /** Descending by count, so the dominant type reads first. */
  byType: TypeCount[];
  /**
   * Distinct pull requests whose head was actually read. Approximate in one
   * direction only: a round the lane recorded without a round type, or without a
   * pr_number, cannot be attributed, so this can undercount and never overcount.
   */
  prsReviewed: number;
  /** Rounds excluded from prsReviewed because they carry no round type. */
  untypedRounds: number;
  reposActive: number;
  /**
   * Calendar days the window's rounds actually span, at least one. The divisor
   * for a per-day mean: the nominal range would divide by 90 days of which 83
   * hold nothing.
   */
  daysSpanned: number;
}

export function activityBand(rows: RoundRow[]): ActivityBand {
  const types = new Map<string, number>();
  const prs = new Set<string>();
  const repos = new Set<string>();
  const days = new Set<string>();
  let untypedRounds = 0;

  for (const row of rows) {
    repos.add(row.repository);
    days.add(localDay(row.recorded_at));
    if (row.round_type === null) {
      untypedRounds++;
    } else {
      types.set(row.round_type, (types.get(row.round_type) ?? 0) + 1);
    }
    if (decodeVerdict(row) === "reviewed" && row.pr_number !== null) {
      prs.add(`${row.repository}#${row.pr_number}`);
    }
  }

  return {
    rounds: rows.length,
    byType: [...types.entries()]
      .map(([type, rounds]) => ({ type, rounds }))
      .sort((a, b) => b.rounds - a.rounds || a.type.localeCompare(b.type)),
    prsReviewed: prs.size,
    untypedRounds,
    reposActive: repos.size,
    daysSpanned: Math.max(1, days.size),
  };
}

export interface DayBucket {
  day: string;
  total: number;
  /** One key per round type present in the window. */
  [type: string]: number | string;
}

/**
 * One bucket per calendar day from the first round/change to the last, gaps included.
 * Dropping the empty days would draw a denser lane than ran.
 */
export function roundsPerDay(
  rows: RoundRow[],
  types: string[],
  changes: ChangeRow[] = [],
): DayBucket[] {
  if (rows.length === 0 && changes.length === 0) return [];
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const day = localDay(row.recorded_at);
    const type = row.round_type ?? "untyped";
    const bucket = counts.get(day) ?? new Map<string, number>();
    bucket.set(type, (bucket.get(type) ?? 0) + 1);
    counts.set(day, bucket);
  }
  return eachDay(rows, changes).map((day) => {
    const bucket = counts.get(day) ?? new Map<string, number>();
    const out: DayBucket = { day, total: 0 };
    for (const type of types) {
      const n = bucket.get(type) ?? 0;
      out[type] = n;
      out.total += n;
    }
    return out;
  });
}

export interface TokenDayBucket {
  day: string;
  input: number;
  cacheCreation: number;
  cacheRead: number;
}

/** Same day buckets, summing the three input token columns the store holds. */
export function tokensPerDay(
  rows: RoundRow[],
  changes: ChangeRow[] = [],
): TokenDayBucket[] {
  if (rows.length === 0 && changes.length === 0) return [];
  const buckets = new Map<string, TokenDayBucket>();
  for (const row of rows) {
    const day = localDay(row.recorded_at);
    const bucket = buckets.get(day) ?? { day, input: 0, cacheCreation: 0, cacheRead: 0 };
    bucket.input += row.input_tokens ?? 0;
    bucket.cacheCreation += row.cache_creation_input_tokens ?? 0;
    bucket.cacheRead += row.cache_read_input_tokens ?? 0;
    buckets.set(day, bucket);
  }
  return eachDay(rows, changes).map(
    (day) => buckets.get(day) ?? { day, input: 0, cacheCreation: 0, cacheRead: 0 },
  );
}

export interface ScatterPoint {
  /** Epoch milliseconds, so the x axis is time and not row order. */
  at: number;
  durationMs: number;
  sessionId: string;
  repository: string;
  state: VerdictState;
}

/** Every round that recorded a wall clock. A round without one is not a zero. */
export function wallClockPoints(rows: RoundRow[]): ScatterPoint[] {
  return rows
    .filter((row) => typeof row.duration_ms === "number")
    .map((row) => ({
      at: new Date(row.recorded_at).getTime(),
      durationMs: row.duration_ms as number,
      sessionId: row.session_id,
      repository: row.repository,
      state: decodeVerdict(row),
    }));
}

/** The distinct round types in the window, dominant first, untyped rounds last. */
export function roundTypesPresent(band: ActivityBand): string[] {
  const types = band.byType.map((entry) => entry.type);
  return band.untypedRounds > 0 ? [...types, "untyped"] : types;
}

/**
 * Walks local calendar days from the earliest instant to the latest via
 * setDate/getDate, so a DST transition in the viewer's zone neither skips nor
 * repeats a day the way stepping by a fixed 24h would (#97).
 */
function eachDay(rows: RoundRow[], changes: ChangeRow[] = []): string[] {
  const stamps = [
    ...rows.map((row) => Date.parse(row.recorded_at)),
    ...changes.map((c) => Date.parse(c.at)),
  ].filter((n) => !Number.isNaN(n));
  if (stamps.length === 0) return [];

  const cursor = new Date(Math.min(...stamps));
  const lastDay = localDay(new Date(Math.max(...stamps)).toISOString());
  const days: string[] = [];
  for (let day = localDay(cursor.toISOString()); day <= lastDay; ) {
    days.push(day);
    cursor.setDate(cursor.getDate() + 1);
    day = localDay(cursor.toISOString());
  }
  return days;
}

/**
 * Filter changes from the registry whose `at` falls inside the chart's current window,
 * and whose scope matches the chart's repository filter.
 * A `repo`-scoped change only draws on charts showing that repository;
 * a `fleet`-scoped change always draws.
 */
export function changesInWindow(
  changes: ChangeRow[],
  range: RangeKey,
  now: Date,
  rows: RoundRow[],
  repository?: string,
): ChangeRow[] {
  const applicable = changes.filter((c) => {
    if (c.scope === "fleet") return true;
    if (c.scope === "repo") return repository !== undefined && c.repository === repository;
    return false;
  });

  if (applicable.length === 0) return [];

  const nowIso = now.toISOString();

  const marker = parseMarkerRange(range);
  if (marker) {
    const fromChange = changes.find((c) => c.id === marker.fromId);
    const toChange = changes.find((c) => c.id === marker.toId);
    if (!fromChange || !toChange) return [];
    const [early, late] =
      fromChange.at <= toChange.at ? [fromChange, toChange] : [toChange, fromChange];
    return applicable.filter((c) => c.at >= early.at && c.at <= late.at);
  }

  if (range === "30d" || range === "90d") {
    const days = range === "30d" ? 30 : 90;
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    return applicable.filter((c) => c.at >= cutoff && c.at <= nowIso);
  }

  if (range === "all") {
    if (rows.length === 0) return [];
    const earliestRound = rows.reduce(
      (min, r) => (r.recorded_at < min ? r.recorded_at : min),
      rows[0].recorded_at,
    );
    return applicable.filter((c) => c.at >= earliestRound && c.at <= nowIso);
  }

  // rolling: the last 50 rounds or 7 days, whichever holds more rounds
  const cutoff = new Date(now.getTime() - ROLLING_DAYS * DAY_MS).toISOString();
  const byDays = rows.filter((r) => r.recorded_at >= cutoff);
  const byCount = rows.slice(0, ROLLING_ROUNDS);

  if (byDays.length >= byCount.length) {
    return applicable.filter((c) => c.at >= cutoff && c.at <= nowIso);
  } else {
    if (rows.length === 0) return [];
    const earliest = rows[rows.length - 1].recorded_at;
    return applicable.filter((c) => c.at >= earliest && c.at <= nowIso);
  }
}
