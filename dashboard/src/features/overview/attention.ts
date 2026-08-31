import { parseRawResult } from "@/api/blobs";
import type { RoundRow } from "@/api/types";

/**
 * The three card kinds the recorded columns support. The artboard also draws
 * silent rounds, fallback reasons, stale findings and malformed config; none of
 * those is a field the store holds, and inventing a card for one would put a
 * shape on screen with nothing behind it. Each arrives with its own issue (#46).
 */
export type AttentionKind = "denials" | "retry" | "error";

export interface AttentionCard {
  kind: AttentionKind;
  reason: string;
  detail: string;
  row: RoundRow;
}

export const ATTENTION_KIND_COPY: Record<AttentionKind, string> = {
  denials: "a tool the lane asked for and did not get",
  retry: "the workflow run was attempted more than once",
  error: "the action itself reported an error",
};

/**
 * One card per round per reason, newest first. A round can earn more than one:
 * a retried attempt that also errored is two facts about it, not one.
 */
export function attentionCards(rows: RoundRow[]): AttentionCard[] {
  const cards: AttentionCard[] = [];

  for (const row of rows) {
    const raw = parseRawResult(row);

    if (raw?.is_error === true) {
      const named = raw.api_error_status ?? raw.subtype ?? raw.stop_reason ?? null;
      cards.push({
        kind: "error",
        reason: "the action reported an error",
        detail: named ? `result: ${named}` : "raw_result carries no reason for the error",
        row,
      });
    }

    if (row.permission_denials !== null && row.permission_denials > 0) {
      // parseRawResult normalises an absent or unusable denial list to undefined
      // and keeps an empty array, so the two are told apart rather than merged.
      const tools = raw?.denial_tools;
      cards.push({
        kind: "denials",
        reason: `${row.permission_denials} permission ${row.permission_denials === 1 ? "denial" : "denials"}`,
        detail:
          tools === undefined
            ? "denial_tools is absent or unreadable, so the tools are not named"
            : tools.length > 0
              ? tools.map((tool) => `${tool.tool} x${tool.count}`).join(", ")
              : "the round counts denials but names no tool",
        row,
      });
    }

    if (row.run_attempt !== null && row.run_attempt > 1) {
      cards.push({
        kind: "retry",
        reason: `attempt ${row.run_attempt}`,
        // Earlier attempts are not rows of their own, so why the first one failed
        // is in the Actions run and not here.
        detail: "only the attempt that recorded a round is stored; the run holds the rest",
        row,
      });
    }
  }

  return cards.sort((a, b) => b.row.recorded_at.localeCompare(a.row.recorded_at));
}
