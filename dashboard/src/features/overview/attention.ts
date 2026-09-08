import { parseRawResult } from "@/api/blobs";
import type { FindingRow, RoundRow } from "@/api/types";
import { neverAnsweredFindings } from "@/features/findings/findings";

/**
 * The card kinds a recorded column supports: three off `rounds`, and
 * never-answered off `review_findings` since #111 landed that table. The
 * artboard also draws silent rounds, fallback reasons and malformed config;
 * none of those is a field the store holds, and inventing a card for one would
 * put a shape on screen with nothing behind it. Each arrives with its own
 * issue (#46).
 */
export type RoundAttentionKind = "denials" | "retry" | "error";
export type AttentionKind = RoundAttentionKind | "never-answered";

export interface RoundAttentionCard {
  source: "round";
  kind: RoundAttentionKind;
  reason: string;
  detail: string;
  row: RoundRow;
}

/**
 * A finding is PR-grain, never round-grain (#111 refuses the timestamp inference
 * that would attribute a thread to a round), so its card carries the finding and
 * has no RoundRow at all. The feed renders the round-only columns as absent
 * rather than borrowing a plausible round.
 */
export interface FindingAttentionCard {
  source: "finding";
  kind: "never-answered";
  reason: string;
  detail: string;
  finding: FindingRow;
}

export type AttentionCard = RoundAttentionCard | FindingAttentionCard;

export const ATTENTION_KIND_COPY: Record<AttentionKind, string> = {
  denials: "a tool the lane asked for and did not get",
  retry: "the workflow run was attempted more than once",
  error: "the action itself reported an error",
  "never-answered": "the lane reported a finding, nobody replied and the thread is still open",
};

/**
 * One card per round per reason, newest first. A round can earn more than one:
 * a retried attempt that also errored is two facts about it, not one.
 */
export function attentionCards(rows: RoundRow[]): RoundAttentionCard[] {
  const cards: RoundAttentionCard[] = [];

  for (const row of rows) {
    const raw = parseRawResult(row);

    if (raw?.is_error === true) {
      const named = raw.api_error_status ?? raw.subtype ?? raw.stop_reason ?? null;
      cards.push({
        source: "round",
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
        source: "round",
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
        source: "round",
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

/**
 * Never-answered findings as feed items (#111). Not scoped by the round range:
 * `review_findings` carries no round, and the sweep writes a thread's own
 * creation time, so the feed states these separately rather than implying the
 * round window covers them.
 */
export function findingAttentionCards(rows: FindingRow[]): FindingAttentionCard[] {
  return neverAnsweredFindings(rows)
    .map((finding): FindingAttentionCard => {
      const where =
        finding.path === null
          ? "no path recorded on the thread"
          : finding.original_line === null
            ? finding.path
            : `${finding.path}:${finding.original_line}`;
      return {
        source: "finding",
        kind: "never-answered",
        reason: "never answered",
        detail: finding.header_raw ? `${where} - ${finding.header_raw}` : where,
        finding,
      };
    })
    .sort((a, b) =>
      // A thread with no creation time recorded sorts last rather than at the
      // top, which is where an empty string would put it.
      (b.finding.thread_created_at ?? "").localeCompare(a.finding.thread_created_at ?? ""),
    );
}
