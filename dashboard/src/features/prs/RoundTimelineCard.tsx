import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import type { RoundRow } from "@/api/types";
import { Timestamp } from "@/components/Timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DenialsPanel,
  FanOutPanel,
  RawRecordPanel,
  ResolutionPanel,
  TimingPanel,
  TokensPanel,
} from "@/features/rounds/panels";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatUsd,
  orDash,
  shortSha,
} from "@/lib/format";
import { decodeHeadStatus } from "./headStatus";

export interface RoundTimelineCardProps {
  round: RoundRow;
  index: number;
  totalRounds: number;
}

export function RoundTimelineCard({
  round,
  index,
  totalRounds,
}: RoundTimelineCardProps) {
  const [expanded, setExpanded] = useState(false);
  const status = decodeHeadStatus(round);
  const ordinal = round.round_ordinal ?? (totalRounds - index);

  const totalInput =
    (round.input_tokens ?? 0) +
    (round.cache_read_input_tokens ?? 0) +
    (round.cache_creation_input_tokens ?? 0);
  const cacheHitRatio =
    totalInput > 0 && round.cache_read_input_tokens !== null
      ? round.cache_read_input_tokens / totalInput
      : null;

  return (
    <div className="relative flex gap-4 pb-6 last:pb-0" data-testid="round-timeline-card">
      {/* Timeline line and dot */}
      <div className="flex flex-col items-center pt-1.5 shrink-0">
        <div
          className={`size-3 rounded-full border-2 ${
            status.headRead
              ? "border-[#3AA368] bg-[#3AA368]"
              : "border-muted-foreground bg-background"
          }`}
        />
        {index < totalRounds - 1 && <div className="w-0.5 grow bg-border mt-1" />}
      </div>

      {/* Card */}
      <div className="flex-1 rounded-lg border border-border bg-card p-4 text-card-foreground">
        {/* Header line */}
        <div className="flex flex-wrap items-center gap-2 justify-between border-b border-border/40 pb-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold">
              Round {ordinal} · {round.round_type ?? "review"}
            </span>

            {round.fallback_reason && (
              <Badge variant="warning" className="text-[10px] px-1.5 py-0">
                fallback: {round.fallback_reason}
              </Badge>
            )}

            <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
              {round.model ?? "—"}
              {round.model_source ? ` · ${round.model_source}` : ""}
            </Badge>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Timestamp iso={round.recorded_at} />
            <span>·</span>
            <Link
              to="/rounds/$sessionId"
              params={{ sessionId: round.session_id }}
              search={{ at: round.recorded_at }}
              className="text-primary underline-offset-4 hover:underline"
            >
              round
            </Link>
            {round.run_url && (
              <>
                <span>·</span>
                <a
                  href={round.run_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
                >
                  run <ExternalLink className="size-3" />
                </a>
              </>
            )}
            {round.pr_url && (
              <>
                <span>·</span>
                <a
                  href={round.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
                >
                  summary <ExternalLink className="size-3" />
                </a>
              </>
            )}
          </div>
        </div>

        {/* Verdict line */}
        <div className="my-2.5 rounded bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
          {status.rawVerdict}
        </div>

        {/* What it read and what it posted */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground py-1 border-b border-border/30">
          <div>
            <span className="font-medium text-foreground">Read: </span>
            {round.changed_files !== null || round.diff_lines !== null
              ? `${orDash(round.changed_files)} files, ${orDash(round.diff_lines)} lines`
              : "—"}
            {round.range_base && round.range_head ? (
              <span className="font-mono text-[11px] ml-1">
                ({shortSha(round.range_base)}..{shortSha(round.range_head)})
              </span>
            ) : null}
          </div>
          <div>
            <span className="font-medium text-foreground">Posted: </span>
            {round.inline_count !== null || round.summary_count !== null
              ? `${orDash(round.inline_count)} inline / ${orDash(round.summary_count)} summary comments`
              : "0 comments"}
          </div>
        </div>

        {/* One-line telemetry */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-2.5 tabular">
          <span>{orDash(round.duration_ms, formatDuration)}</span>
          <span>{orDash(round.num_turns)} turns</span>
          <span className={round.permission_denials ? "text-[var(--warning)] font-medium" : ""}>
            {formatCount(round.permission_denials ?? 0)} denials
          </span>
          {cacheHitRatio !== null && <span>cache {formatPercent(cacheHitRatio)}</span>}
          <span>{orDash(round.total_cost_usd, formatUsd)} list-rate eq</span>
        </div>

        {/* Expander button */}
        <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((prev) => !prev)}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <>
                <ChevronDown className="size-3.5 mr-1" /> Hide round panels
              </>
            ) : (
              <>
                <ChevronRight className="size-3.5 mr-1" /> Show round panels
              </>
            )}
          </Button>

          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
            <Link
              to="/rounds/$sessionId"
              params={{ sessionId: round.session_id }}
              search={{ at: round.recorded_at }}
            >
              Open round detail
            </Link>
          </Button>
        </div>

        {/* Mirror round detail panels (#75) */}
        {expanded && (
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2 border-t border-border pt-4">
            <ResolutionPanel row={round} />
            <TimingPanel row={round} />
            <FanOutPanel row={round} />
            <TokensPanel row={round} />
            <DenialsPanel row={round} />
            <RawRecordPanel row={round} />
          </div>
        )}
      </div>
    </div>
  );
}
