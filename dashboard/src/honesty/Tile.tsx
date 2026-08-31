import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Formatter } from "@/lib/format";
import { formatCount } from "@/lib/format";
import { Approximate } from "./Degraded";
import type { Metric } from "./metrics";
import {
  LIST_RATE_EQUIVALENT,
  LOW_N_THRESHOLD,
  MONEY_LABEL_PATTERN,
  P95_MIN_N,
} from "./thresholds";

/** Exported so the guard can be asserted without rendering a tile. */
export function isMoneyLabel(label: string): boolean {
  return (
    MONEY_LABEL_PATTERN.test(label) ||
    label.toLowerCase().includes(LIST_RATE_EQUIVALENT.toLowerCase())
  );
}

export interface TileProps {
  label: string;
  metric: Metric;
  format: Formatter;
  /** One line under the number saying what it is measured over. */
  hint?: string;
  className?: string;
}

/**
 * The only tile in the dashboard. It takes a Metric rather than a number, which
 * is what forces n onto every tile and keeps the p95 and low-n rules of #46 out
 * of each screen's hands.
 */
export function Tile({ label, metric, format, hint, className }: TileProps) {
  if (isMoneyLabel(label)) {
    // total_cost_usd is a sortable column labelled list-rate equivalent, never a
    // headline: it is counterfactual on a subscription seat (#46).
    throw new Error(
      `Tile refuses the label "${label}": money is a table column, never a headline tile.`,
    );
  }

  return (
    <Card className={cn("min-w-0", className)}>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <RoundCount metric={metric} />
        </div>

        {metric.kind === "empty" ? (
          <span className="text-lg font-semibold text-muted-foreground">no rounds in range</span>
        ) : (
          <span className="tabular text-2xl font-semibold">{format(metric.value)}</span>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {metric.kind === "substituted" && (
            <Badge variant="warning" title={`p95 needs n ≥ ${P95_MIN_N}`}>
              max, not p95
            </Badge>
          )}
          {metric.kind === "value" && metric.lowN && (
            <Badge variant="warning" title={`fewer than ${LOW_N_THRESHOLD} rounds behind this`}>
              low n
            </Badge>
          )}
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export interface CountTileProps {
  label: string;
  /** The count itself. It is its own n, which is why there is no Metric here. */
  count: number;
  /** What the count is made of, e.g. the split by round type. */
  detail?: ReactNode;
  /** The volume-dependent line: an all-time cumulative or a per-day mean. */
  support?: ReactNode;
  /** Why the count is an approximation, if it is. Renders the approximate badge. */
  approximate?: string;
  className?: string;
}

/**
 * A count headline. Separate from Tile because a count is true at any n and an
 * average is not: a count of 4 rounds is exactly 4 rounds, so it neither carries
 * a low-n flag nor collapses into the round table the way an aggregate does. The
 * money guard still applies, because a sum of dollars is a count of nothing (#46).
 */
export function CountTile({
  label,
  count,
  detail,
  support,
  approximate,
  className,
}: CountTileProps) {
  if (isMoneyLabel(label)) {
    throw new Error(
      `CountTile refuses the label "${label}": money is a table column, never a headline tile.`,
    );
  }

  return (
    <Card className={cn("min-w-0", className)}>
      <CardContent className="flex flex-col gap-1 p-4" data-testid="count-tile">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {approximate && <Approximate why={approximate} />}
        </div>
        <span className="tabular text-3xl font-semibold">{formatCount(count)}</span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
        {support && <span className="text-xs text-muted-foreground">{support}</span>}
      </CardContent>
    </Card>
  );
}

/** n is not optional. Every tile states the round count behind its number. */
function RoundCount({ metric }: { metric: Metric }) {
  return (
    <span className="tabular shrink-0 text-xs text-muted-foreground" data-testid="tile-n">
      n = {formatCount(metric.n)}
    </span>
  );
}
