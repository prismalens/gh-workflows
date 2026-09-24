import type { FindingRow } from "@/api/types";

export type Severity = "critical" | "major" | "minor" | "nitpick";

export interface FindingLabel {
  category: string | null;
  severity: Severity | null;
}

const SEVERITIES: Severity[] = ["critical", "major", "minor", "nitpick"];

function clean(segment: string): string {
  return segment
    .replace(/[_*`]/g, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .trim();
}

/**
 * Reads `_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_`, the first
 * line of a reviewer's finding. The sweep does not always split it into
 * `header_raw` yet (#211), so the body's first line is the fallback.
 */
export function parseFindingLabel(row: Pick<FindingRow, "header_raw" | "body_excerpt">): FindingLabel {
  const line = (row.header_raw ?? row.body_excerpt ?? "").split("\n")[0] ?? "";
  if (!line.includes("|")) return { category: null, severity: null };
  const parts = line.split("|").map(clean).filter(Boolean);
  let severity: Severity | null = null;
  for (const part of parts) {
    const hit = SEVERITIES.find((s) => part.toLowerCase() === s);
    if (hit) {
      severity = hit;
      break;
    }
  }
  const category = parts.find((p) => !SEVERITIES.includes(p.toLowerCase() as Severity)) ?? null;
  return { category, severity };
}

/** The body with its label line removed, so a table cell shows the finding, not its tags. */
export function findingBodyText(row: Pick<FindingRow, "header_raw" | "body_excerpt">): string | null {
  const body = row.body_excerpt;
  if (!body) return null;
  const lines = body.split("\n");
  const rest = row.header_raw || !lines[0]?.includes("|") ? lines : lines.slice(1);
  const joined = rest.join("\n");
  // A reviewer's <details> block is supporting evidence; the finding is what sits outside it.
  const outside = joined.replace(/<details>[\s\S]*?(<\/details>|$)/g, " ");
  const source = outside.replace(/<[^>]+>/g, " ").trim() ? outside : joined;
  const text = source
    .replace(/<[^>]+>/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, "")
    .replace(/[_*`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
