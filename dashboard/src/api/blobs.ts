import type { ModelUsage, RawResult, RoundRow } from "./types";

/** The three blob columns arrive as JSON strings, and any of them can be null. */
function parseJson<T>(raw: string | null | undefined): T | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed as T;
  } catch {
    return null;
  }
}

export function parsePerModelUsage(row: RoundRow): Record<string, ModelUsage> | null {
  const parsed = parseJson<Record<string, ModelUsage>>(row.per_model_usage);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return Object.keys(parsed).length > 0 ? parsed : null;
}

export function parseRawResult(row: RoundRow): RawResult | null {
  const parsed = parseJson<RawResult>(row.raw_result);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

export interface CountEntry {
  key: string;
  value: number;
}

export interface FanOutStats {
  /** Numeric leaves at the top level: the lifecycle counters. */
  lifecycle: CountEntry[];
  /** One level of nesting, each a named group of numeric leaves. */
  groups: Array<{ key: string; entries: CountEntry[] }>;
  /** The column held something, but nothing in it was countable. */
  unreadable: boolean;
}

/**
 * `subagent_stats` is passed through from the action's result object, so its
 * exact keys are not ours to pin. Anything numeric is rendered as a count and
 * anything else is ignored rather than guessed at.
 */
export function parseSubagentStats(row: RoundRow): FanOutStats | null {
  const parsed = parseJson<Record<string, unknown>>(row.subagent_stats);
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { lifecycle: [], groups: [], unreadable: true };
  }

  const lifecycle: CountEntry[] = [];
  const groups: FanOutStats["groups"] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      lifecycle.push({ key, value });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries: CountEntry[] = [];
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof innerValue === "number" && Number.isFinite(innerValue)) {
          entries.push({ key: innerKey, value: innerValue });
        }
      }
      if (entries.length > 0) groups.push({ key, entries });
    } else if (Array.isArray(value)) {
      lifecycle.push({ key: `${key} (length)`, value: value.length });
    }
  }

  const unreadable = lifecycle.length === 0 && groups.length === 0;
  return { lifecycle, groups, unreadable };
}

export function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}
