/**
 * One filter grammar for every list (#209): `key:value` tokens plus free text.
 * A token is a view of one URL search param, so a copied link, reload and back
 * all restore it; the grammar never holds state of its own.
 */
export const FILTER_KEYS = ["repo", "author", "path", "fate", "age", "sev", "state", "pr"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export interface FilterToken {
  key: FilterKey;
  value: string;
}

export interface ParsedQuery {
  tokens: FilterToken[];
  text: string;
}

export const FILTER_KEY_HINTS: Record<FilterKey, string> = {
  repo: "repository, owner/name or part of it",
  author: "pull request author",
  path: "file path, prefix or part",
  fate: "never-answered, pushback-open, resolved-by-human, self-graded, fix-cited",
  age: ">7d, <1d, >4w",
  sev: "critical, major, minor, nitpick",
  state: "open, merged, closed, all",
  pr: "pull request number",
};

function isFilterKey(value: string): value is FilterKey {
  return (FILTER_KEYS as readonly string[]).includes(value);
}

/** Later tokens win over earlier ones with the same key, like a URL param. */
export function parseQuery(input: string): ParsedQuery {
  const byKey = new Map<FilterKey, string>();
  const words: string[] = [];
  for (const word of input.trim().split(/\s+/)) {
    if (!word) continue;
    const colon = word.indexOf(":");
    const key = colon > 0 ? word.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? word.slice(colon + 1) : "";
    if (isFilterKey(key) && value) byKey.set(key, value);
    else words.push(word);
  }
  const tokens = FILTER_KEYS.flatMap((key) => {
    const value = byKey.get(key);
    return value ? [{ key, value }] : [];
  });
  return { tokens, text: words.join(" ") };
}

export function serializeQuery({ tokens, text }: ParsedQuery): string {
  return [...tokens.map((t) => `${t.key}:${t.value}`), text].filter(Boolean).join(" ");
}

export interface AgeBound {
  op: ">" | "<";
  days: number;
}

/** `>7d`, `<1d`, `>4w`, `>36h`. A bare number means days older than. */
export function parseAge(value: string): AgeBound | null {
  const m = /^([<>])?(\d+(?:\.\d+)?)([hdw])?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[2]);
  const unit = m[3] ?? "d";
  const days = unit === "h" ? n / 24 : unit === "w" ? n * 7 : n;
  return { op: (m[1] as ">" | "<" | undefined) ?? ">", days };
}

export function matchesAge(ageDays: number | null, bound: AgeBound | null): boolean {
  if (!bound) return true;
  if (ageDays === null) return false;
  return bound.op === ">" ? ageDays > bound.days : ageDays < bound.days;
}
