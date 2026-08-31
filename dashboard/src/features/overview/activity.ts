import type { RoundRow } from "@/api/types";
import { decodeVerdict } from "@/honesty/verdict";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day a round landed on. Buckets are UTC, like recorded_at. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

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
    days.add(utcDay(row.recorded_at));
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
 * One bucket per calendar day from the first round to the last, gaps included.
 * Dropping the empty days would draw a denser lane than ran.
 */
export function roundsPerDay(rows: RoundRow[], types: string[]): DayBucket[] {
  if (rows.length === 0) return [];
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const day = utcDay(row.recorded_at);
    const type = row.round_type ?? "untyped";
    const bucket = counts.get(day) ?? new Map<string, number>();
    bucket.set(type, (bucket.get(type) ?? 0) + 1);
    counts.set(day, bucket);
  }
  return eachDay(rows).map((day) => {
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
export function tokensPerDay(rows: RoundRow[]): TokenDayBucket[] {
  if (rows.length === 0) return [];
  const buckets = new Map<string, TokenDayBucket>();
  for (const row of rows) {
    const day = utcDay(row.recorded_at);
    const bucket = buckets.get(day) ?? { day, input: 0, cacheCreation: 0, cacheRead: 0 };
    bucket.input += row.input_tokens ?? 0;
    bucket.cacheCreation += row.cache_creation_input_tokens ?? 0;
    bucket.cacheRead += row.cache_read_input_tokens ?? 0;
    buckets.set(day, bucket);
  }
  return eachDay(rows).map(
    (day) => buckets.get(day) ?? { day, input: 0, cacheCreation: 0, cacheRead: 0 },
  );
}

export interface ScatterPoint {
  /** Epoch milliseconds, so the x axis is time and not row order. */
  at: number;
  durationMs: number;
  sessionId: string;
  repository: string;
  state: "reviewed" | "unknown";
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

function eachDay(rows: RoundRow[]): string[] {
  const stamps = rows.map((row) => Date.parse(utcDay(row.recorded_at)));
  const first = Math.min(...stamps);
  const last = Math.max(...stamps);
  const days: string[] = [];
  for (let t = first; t <= last; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
