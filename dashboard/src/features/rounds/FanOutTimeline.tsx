import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatDuration, formatTokens } from "@/lib/format";
import { CACHE_CREATION_WEIGHT, CACHE_READ_WEIGHT } from "@/honesty/thresholds";
import type { RoundAgentRow } from "@/api/types";

// Palette mapped per subagent_type (#89 ruling: bar colour is subagent_type).
const SUBAGENT_PALETTE: Record<string, { fill: string; border: string; text: string }> = {
  "general-purpose": {
    fill: "rgba(59, 130, 246, 0.2)",
    border: "rgb(59, 130, 246)",
    text: "rgb(37, 99, 235)",
  },
  reviewer: {
    fill: "rgba(16, 185, 129, 0.2)",
    border: "rgb(16, 185, 129)",
    text: "rgb(5, 150, 105)",
  },
  worker: {
    fill: "rgba(99, 102, 241, 0.2)",
    border: "rgb(99, 102, 241)",
    text: "rgb(79, 70, 229)",
  },
  tester: {
    fill: "rgba(245, 158, 11, 0.2)",
    border: "rgb(245, 158, 11)",
    text: "rgb(217, 119, 6)",
  },
  scout: {
    fill: "rgba(168, 85, 247, 0.2)",
    border: "rgb(168, 85, 247)",
    text: "rgb(147, 51, 234)",
  },
  research: {
    fill: "rgba(6, 182, 212, 0.2)",
    border: "rgb(6, 182, 212)",
    text: "rgb(8, 145, 178)",
  },
};

const DEFAULT_PALETTE = {
  fill: "rgba(107, 114, 128, 0.2)",
  border: "rgb(107, 114, 128)",
  text: "rgb(75, 85, 99)",
};

export function getSubagentColors(type: string | null) {
  if (!type) return DEFAULT_PALETTE;
  return SUBAGENT_PALETTE[type] ?? DEFAULT_PALETTE;
}

export function formatAgentsStatusReason(status?: string | null): string {
  switch (status) {
    case "ok":
      return "This round spawned no agents.";
    case "skipped":
      return "Agent rollup was skipped for this round.";
    case "no-transcript-dir":
      return "Agent rollup failed: no transcript directory found.";
    case "no-execution-file":
      return "Agent rollup failed: no execution file found.";
    case "no-session-id":
      return "Agent rollup failed: no session ID found.";
    case "parse-failed":
      return "Agent rollup failed: could not parse agent transcripts.";
    case "script-failed":
      return "Agent rollup failed: rollup script failed.";
    default:
      return status
        ? `Agent rollup outcome: ${status}.`
        : "This round was recorded before the agent rollup landed; no per-agent rows exist.";
  }
}

/**
 * Weighted billed tokens identity: input + 1.25*create + 0.1*read + output (#46, #89).
 * Returns null when token counts are null so cost encoding is absent (#89).
 */
export function computeAgentCost(agent: RoundAgentRow): number | null {
  const hasTokens =
    agent.input_tokens !== null ||
    agent.output_tokens !== null ||
    agent.cache_read_input_tokens !== null ||
    agent.cache_creation_input_tokens !== null;

  if (!hasTokens) return null;

  const input = agent.input_tokens ?? 0;
  const output = agent.output_tokens ?? 0;
  const read = agent.cache_read_input_tokens ?? 0;
  const create = agent.cache_creation_input_tokens ?? 0;

  return input + CACHE_CREATION_WEIGHT * create + CACHE_READ_WEIGHT * read + output;
}

export interface FanOutTimelineProps {
  agents: RoundAgentRow[];
  agentsStatus?: string | null;
  wallClockMs?: number | null;
}

export function FanOutTimeline({ agents, agentsStatus, wallClockMs }: FanOutTimelineProps) {
  // Never fall back to subagent_stats (#89 ruling).
  if (!agents || agents.length === 0) {
    const reasonText = formatAgentsStatusReason(agentsStatus);
    return (
      <div data-testid="agents-empty-state" data-reason={agentsStatus ?? "predates-rollup"}>
        <Alert variant="muted">
          <AlertTitle>No agent timeline available</AlertTitle>
          <AlertDescription>{reasonText}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Determine wall-clock scale bound: max of agents' duration and round wall clock.
  const agentMaxMs = Math.max(...agents.map((a) => a.duration_ms ?? 0));
  const scaleMaxMs = Math.max(agentMaxMs, wallClockMs ?? 0, 1000);

  // Compute costs to determine density range
  const costs = agents.map(computeAgentCost);
  const validCosts = costs.filter((c): c is number => c !== null);
  const maxCost = validCosts.length > 0 ? Math.max(...validCosts, 1) : 1;
  const anyUnknownCost = costs.some((c) => c === null);

  const subagentTypes = [...new Set(agents.map((a) => a.subagent_type).filter(Boolean))];

  return (
    <div className="flex flex-col gap-4" data-testid="fan-out-timeline">
      {/* Wall clock header axis */}
      <div className="flex justify-between items-center text-xs text-muted-foreground border-b border-border/40 pb-1 font-mono">
        <span>0ms</span>
        <span>{formatDuration(Math.round(scaleMaxMs / 2))}</span>
        <span>{formatDuration(scaleMaxMs)}</span>
      </div>

      {/* Agents rows */}
      <div className="flex flex-col gap-2.5">
        {agents.map((agent) => {
          const cost = computeAgentCost(agent);
          const duration = agent.duration_ms ?? 0;
          const isRefused = agent.status === "refused";
          const isFailed = agent.status === "failed";
          const isDegradedStatus = isRefused || isFailed;

          // Width percent: minimum visual width for refused/failed so never omitted (#89).
          const rawWidthPercent = (duration / scaleMaxMs) * 100;
          const widthPercent = isDegradedStatus
            ? Math.max(rawWidthPercent, 4)
            : Math.max(rawWidthPercent, 2);

          const colors = getSubagentColors(agent.subagent_type);
          const shortId = agent.agent_id.slice(0, 8);

          // Cost density calculation: normalized 0.2 - 0.95 opacity
          const costDensity =
            cost !== null && maxCost > 0
              ? cost === 0
                ? 0
                : 0.2 + 0.75 * (cost / maxCost)
              : null;

          return (
            <div
              key={agent.agent_id}
              className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 text-xs"
              data-testid="agent-row"
              data-agent-id={agent.agent_id}
            >
              {/* Agent identity label */}
              <div className="flex items-center gap-1.5 w-48 shrink-0 min-w-0" data-testid="agent-label">
                <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0 font-mono">
                  d={agent.spawn_depth ?? 1}
                </Badge>
                <span className="font-mono font-medium truncate" style={{ color: colors.text }}>
                  {agent.subagent_type ?? "unknown"}
                </span>
                <span className="font-mono text-muted-foreground truncate">{shortId}</span>
                {isDegradedStatus && (
                  <Badge
                    variant="destructive"
                    className="text-[10px] px-1 py-0 uppercase tracking-wider shrink-0"
                    data-testid="agent-status-badge"
                  >
                    {agent.status}
                  </Badge>
                )}
              </div>

              {/* Bar track on wall clock axis */}
              <div className="flex-1 bg-muted/30 rounded h-6 relative flex items-center px-0.5 overflow-hidden">
                <div
                  className={`h-5 rounded flex items-center justify-between px-2 text-[11px] font-mono transition-all ${
                    isDegradedStatus
                      ? "border-2 border-dashed border-destructive bg-destructive/20"
                      : "border"
                  }`}
                  style={{
                    width: `${widthPercent}%`,
                    borderColor: isDegradedStatus ? undefined : colors.border,
                    backgroundColor:
                      isDegradedStatus
                        ? undefined
                        : cost === null
                          ? "transparent" // Cost encoding absent (#89)
                          : cost === 0
                            ? "transparent"
                            : colors.border,
                    opacity:
                      isDegradedStatus
                        ? 1
                        : cost === null
                          ? 0.8
                          : cost === 0
                            ? 0.5
                            : costDensity ?? 0.5,
                  }}
                  data-testid="agent-bar"
                  data-cost={cost === null ? "unknown" : cost === 0 ? "zero" : "known"}
                  data-status={agent.status}
                >
                  <span className="truncate">{formatDuration(duration)}</span>
                </div>
                {/* Cost label beside bar */}
                <span className="ml-2 text-[10px] text-muted-foreground font-mono shrink-0">
                  {cost === null ? "cost unknown" : cost === 0 ? "0 tokens" : formatTokens(cost)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground pt-2 border-t border-border/40">
        <div className="flex items-center gap-1.5 font-medium">Types:</div>
        {subagentTypes.map((type) => {
          const c = getSubagentColors(type);
          return (
            <div key={type} className="flex items-center gap-1 font-mono">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: c.border }} />
              <span>{type}</span>
            </div>
          );
        })}

        <div className="flex items-center gap-1.5 ml-auto font-medium">Encoding:</div>
        <div className="flex items-center gap-1">
          <span>Bar length: duration</span>
        </div>
        <div className="flex items-center gap-1">
          <span>Fill density: cost</span>
        </div>
        {anyUnknownCost && (
          <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <span>Empty outline: cost encoding absent (null transcript counts)</span>
          </div>
        )}
      </div>
    </div>
  );
}
