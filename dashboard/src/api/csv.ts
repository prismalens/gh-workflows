import type { RoundRow } from "./types";

/** Column order is the schema's, so a CSV round-trips against usage_records. */
export const CSV_COLUMNS = [
  "session_id",
  "recorded_at",
  "repository",
  "pr_number",
  "pr_url",
  "head_sha",
  "run_id",
  "run_attempt",
  "run_url",
  "round_type",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_cost_usd",
  "duration_ms",
  "duration_api_ms",
  "num_turns",
  "permission_denials",
  "changed_files",
  "diff_lines",
] as const satisfies ReadonlyArray<keyof RoundRow>;

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // A leading =, +, - or @ is executed as a formula by Excel and Sheets, and
  // repository and model strings reach here straight from the store.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function roundsToCsv(rows: RoundRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const body = rows.map((row) => CSV_COLUMNS.map((col) => escapeCell(row[col])).join(","));
  return [header, ...body].join("\r\n");
}

/** UTC on purpose (#97): this joins against recorded_at, which is UTC. Do not localise it. */
export function csvFilename(now: Date = new Date()): string {
  return `assayer-rounds-${now.toISOString().slice(0, 10)}.csv`;
}

export function downloadCsv(rows: RoundRow[], filename = csvFilename()): void {
  const blob = new Blob([roundsToCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
