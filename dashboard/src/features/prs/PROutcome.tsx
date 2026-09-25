import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";

import { useFindingsQuery } from "@/api/queries";
import type { RoundRow } from "@/api/types";
import { decodeFate, fixCitation } from "@/features/findings/findings";
import { parseFindingLabel } from "@/features/findings/severity";
import { formatCount, formatDuration, formatRelative, formatUsd, shortSha } from "@/lib/format";
import { cn } from "@/lib/utils";
import { decodeHeadStatus } from "./headStatus";
import { roundLabel, type PRSummary } from "./prs";
import { RoundTimelineCard } from "./RoundTimelineCard";

function Cell({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-border px-4 py-3 not-last:border-r">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <span className={cn("tabular text-xl font-semibold", tone)}>{value}</span>
      {note && <span className="text-[11.5px] text-muted-foreground">{note}</span>}
    </div>
  );
}

/** What the lane did to this PR, before how (#209). Cost is last and marked secondary. */
export function OutcomeStrip({ pr }: { pr: PRSummary }) {
  const findings = useFindingsQuery({ repository: pr.repository, prNumber: pr.number });
  const rows = findings.data?.rows ?? [];
  // A failed read is not zero findings: withhold the counts rather than show a clean 0.
  const findingsValue = (n: number) => (findings.isPending ? "…" : findings.isError && !findings.data ? "—" : formatCount(n));
  const findingsUnread = findings.isError && !findings.data;
  const posted = recordedSum(pr.rounds, "inline_count");
  const open = rows.filter((r) => r.is_resolved !== 1).length;
  const fixed = rows.filter((r) => fixCitation(r) !== null).length;
  const humanResolved = rows.filter((r) => decodeFate(r) === "resolved-by-human").length;
  const sev = rows.reduce<Record<string, number>>((acc, r) => {
    const s = parseFindingLabel(r).severity;
    if (s) acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const sevNote = Object.entries(sev).map(([k, n]) => `${n} ${k}`).join(" · ");
  const wall = recordedSum(pr.rounds, "duration_ms");
  const durations = pr.rounds.map((r) => r.duration_ms).filter((d): d is number => d !== null);
  const cost = recordedSum(pr.rounds, "total_cost_usd");
  const c = pr.roundsCountByType;
  return (
    <section data-testid="pr-outcome" className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card md:grid-cols-3 xl:grid-cols-6">
      <Cell
        label="Findings posted"
        value={posted.total !== null ? formatCount(posted.total) : "—"}
        note={posted.note ?? (findingsUnread ? "findings could not load" : sevNote || `${formatCount(rows.length)} swept`)}
      />
      <Cell
        label="Fix commit cited"
        value={findingsValue(fixed)}
        note={findingsUnread ? "findings could not load" : humanResolved ? `${humanResolved} resolved by a person` : "self-graded unless a person resolved it"}
      />
      <Cell
        label="Still open"
        value={findingsValue(open)}
        note={findingsUnread ? "findings could not load" : "threads on GitHub"}
        tone={!findingsUnread && open > 0 ? "text-[var(--warning)]" : undefined}
      />
      <Cell label="Rounds" value={formatCount(pr.rounds.length)} note={`${c.full} review · ${c.incremental} incremental · ${c.verify} verify`} />
      <Cell
        label="Wall time"
        value={wall.total !== null ? formatDuration(wall.total) : "—"}
        note={wall.note ?? (durations.length ? `longest ${formatDuration(Math.max(...durations))}` : undefined)}
      />
      <Cell label="At list rates" value={cost.total !== null ? formatUsd(cost.total) : "—"} note={cost.note ?? "secondary: seats are flat-rate"} />
    </section>
  );
}

type SummedField = "inline_count" | "duration_ms" | "total_cost_usd";

/** A total over rounds that do not all carry the field is withheld and the field named. */
function recordedSum(rounds: RoundRow[], field: SummedField): { total: number | null; note: string | null } {
  const missing = rounds.filter((r) => r[field] === null).length;
  if (missing > 0) return { total: null, note: `${field} not recorded on ${missing} of ${rounds.length} rounds` };
  return { total: rounds.reduce((s, r) => s + (r[field] ?? 0), 0), note: null };
}

function roundOutcome(round: RoundRow): string {
  const status = decodeHeadStatus(round);
  if (round.round_type === "verify") return status.rawVerdict ?? status.explain;
  if (status.state === "failed" || status.state === "did-not-run") return status.rawVerdict ?? status.explain;
  const files = round.changed_files !== null ? `read ${formatCount(round.changed_files)} file${round.changed_files === 1 ? "" : "s"}` : "changed_files not recorded";
  const from = round.range_base ? ` from ${shortSha(round.range_base)}` : "";
  const posted = round.inline_count;
  const findings = posted !== null ? `posted ${posted} finding${posted === 1 ? "" : "s"}` : "inline_count not recorded";
  return `${files}${from}; ${findings}`;
}

const PIP: Record<string, string> = {
  failed: "bg-[var(--destructive)]",
  "did-not-run": "bg-[var(--warning)]",
  "threads-only": "bg-muted-foreground",
  reviewed: "bg-emerald-400",
};

/** One line per round, newest first; a line opens the full round card in place. */
export function RoundLines({ pr }: { pr: PRSummary }) {
  const [open, setOpen] = useState<string | null>(null);
  const total = pr.rounds.length;
  return (
    <section data-testid="round-lines" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-baseline gap-3 border-b border-border bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-semibold">Rounds</h2>
        <span className="text-xs text-muted-foreground">One line each; open a line for its panels.</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="w-8" />
            <th className="px-2 py-2 font-medium">Round</th>
            <th className="px-2 py-2 font-medium">Type</th>
            <th className="px-2 py-2 font-medium">Outcome</th>
            <th className="px-2 py-2 text-right font-medium">Time</th>
            <th className="px-2 py-2 text-right font-medium">Denials</th>
            <th className="px-2 py-2 text-right font-medium">Cost</th>
            <th className="px-4 py-2 text-right font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {pr.rounds.map((round, idx) => {
            const status = decodeHeadStatus(round);
            const isOpen = open === round.session_id;
            return (
              <Fragment key={round.session_id}>
                <tr
                  data-testid="round-line"
                  onClick={() => setOpen(isOpen ? null : round.session_id)}
                  className="cursor-pointer border-t border-border hover:bg-accent/40"
                >
                  <td className="pl-4">
                    <span className={cn("block size-2 rounded-full", PIP[status.state])} aria-label={status.label} />
                  </td>
                  <td className="px-2 py-2 font-mono whitespace-nowrap">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(isOpen ? null : round.session_id);
                      }}
                      className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <ChevronRight className={cn("mr-1 inline size-3 transition-transform", isOpen && "rotate-90")} aria-hidden />
                      {roundLabel(round, total - idx)}
                    </button>
                  </td>
                  <td className="px-2 py-2">
                    {round.round_type ?? "review"}
                    {round.fallback_reason && (
                      <span className="ml-1.5 rounded border border-[var(--warning)]/50 px-1 text-[10.5px] text-[var(--warning)]">
                        {round.fallback_reason}
                      </span>
                    )}
                  </td>
                  <td className="max-w-[520px] truncate px-2 py-2" title={status.rawVerdict ?? undefined}>
                    {roundOutcome(round)}
                  </td>
                  <td className="tabular px-2 py-2 text-right">{round.duration_ms !== null ? formatDuration(round.duration_ms) : "—"}</td>
                  <td className={cn("tabular px-2 py-2 text-right", (round.permission_denials ?? 0) > 0 && "text-[var(--warning)]")}>
                    {round.permission_denials ?? "—"}
                  </td>
                  <td className="tabular px-2 py-2 text-right text-muted-foreground">
                    {round.total_cost_usd !== null ? formatUsd(round.total_cost_usd) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-muted-foreground" title={round.recorded_at}>
                    {formatRelative(round.recorded_at)}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={8} className="bg-background/40 px-4 py-3">
                      <RoundTimelineCard round={round} index={idx} totalRounds={total} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
