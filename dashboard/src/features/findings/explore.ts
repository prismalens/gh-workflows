import type { FindingRow } from "@/api/types";
import { matchesAge, parseAge } from "@/features/filters/grammar";
import { ageInDays } from "@/lib/format";
import {
  decodeFate,
  fixCitation,
  matchesFateFilter,
  matchesFindingSearch,
  type FateFilterValue,
} from "./findings";
import { parseFindingLabel, type Severity } from "./severity";

export interface FindingFilters {
  repository?: string;
  fate?: FateFilterValue;
  prState?: string;
  path?: string;
  age?: string;
  sev?: string;
  pr?: string;
  q?: string;
}

type FacetKey = "fate" | "repository" | "age" | "sev" | "prState";

export const AGE_BUCKETS = [
  { value: "<1d", label: "under a day" },
  { value: "1d-7d", label: "1 to 7 days" },
  { value: "7d-28d", label: "1 to 4 weeks" },
  { value: ">28d", label: "over 4 weeks" },
] as const;

export function ageBucket(days: number | null): string | null {
  if (days === null) return null;
  if (days < 1) return "<1d";
  if (days < 7) return "1d-7d";
  if (days < 28) return "7d-28d";
  return ">28d";
}

function matchesAgeValue(days: number | null, value: string): boolean {
  if (AGE_BUCKETS.some((b) => b.value === value)) return ageBucket(days) === value;
  return matchesAge(days, parseAge(value));
}

export function severityOf(row: FindingRow): Severity | "none" {
  return parseFindingLabel(row).severity ?? "none";
}

/**
 * Applies every filter except `skip`, so a facet can count what its own options
 * would return with the other filters held (#209).
 */
export function filterFindings(
  rows: FindingRow[],
  f: FindingFilters,
  prStateOf: (row: FindingRow) => string | undefined,
  now: Date,
  skip?: FacetKey,
): FindingRow[] {
  const repo = f.repository?.toLowerCase();
  const path = f.path?.toLowerCase();
  return rows.filter((row) => {
    if (skip !== "repository" && repo && !row.repository.toLowerCase().includes(repo)) return false;
    if (skip !== "fate" && f.fate && !matchesFateFilter(row, f.fate)) return false;
    if (skip !== "prState" && f.prState && f.prState !== "all" && prStateOf(row) !== f.prState) return false;
    if (path && !(row.path ?? "").toLowerCase().includes(path)) return false;
    if (skip !== "age" && f.age && !matchesAgeValue(ageInDays(row.thread_created_at, now), f.age)) return false;
    if (skip !== "sev" && f.sev && severityOf(row) !== f.sev) return false;
    if (f.pr && String(row.pr_number) !== f.pr.replace(/^#/, "")) return false;
    if (f.q && !matchesFindingSearch(row, f.q)) return false;
    return true;
  });
}

export interface FacetCounts {
  fate: Record<string, number>;
  repository: Record<string, number>;
  age: Record<string, number>;
  sev: Record<string, number>;
  prState: Record<string, number>;
}

function tally<T>(rows: T[], keyOf: (row: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyOf(row);
    if (key) out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function facetCounts(
  rows: FindingRow[],
  f: FindingFilters,
  prStateOf: (row: FindingRow) => string | undefined,
  now: Date,
): FacetCounts {
  const fateRows = filterFindings(rows, f, prStateOf, now, "fate");
  const fate = tally(fateRows, (r) => decodeFate(r));
  fate["fix-cited"] = fateRows.filter((r) => fixCitation(r) !== null).length;
  return {
    fate,
    repository: tally(filterFindings(rows, f, prStateOf, now, "repository"), (r) => r.repository),
    age: tally(filterFindings(rows, f, prStateOf, now, "age"), (r) =>
      ageBucket(ageInDays(r.thread_created_at, now)),
    ),
    sev: tally(filterFindings(rows, f, prStateOf, now, "sev"), severityOf),
    prState: tally(filterFindings(rows, f, prStateOf, now, "prState"), (r) => prStateOf(r) ?? "unknown"),
  };
}

export type FindingSort = "oldest" | "newest";

export function sortFindings(rows: FindingRow[], sort: FindingSort): FindingRow[] {
  const dir = sort === "oldest" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ta = a.thread_created_at ?? "";
    const tb = b.thread_created_at ?? "";
    return ta === tb ? 0 : ta < tb ? -dir : dir;
  });
}
