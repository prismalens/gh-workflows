import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDuration } from "@/lib/format";
import type { RoundRow } from "@/api/types";

/**
 * #94 ruling: Ten is the floor below which a percentile is pretending to be a
 * measurement. Below this threshold, draw individual marks, say "n too small to
 * characterise", and refuse to render distribution statistics.
 */
export const WINDOW_DISTRIBUTION_MIN_N = 10;

export interface WindowComparisonPanelProps {
  row: RoundRow;
  windowRounds?: RoundRow[];
}

export function WindowComparisonPanel({ row, windowRounds = [] }: WindowComparisonPanelProps) {
  // Determine variant scope (#94 ruling: either scope to variant_key or label mixed).
  const currentVariantKey = row.variant_key;
  const isVariantScoped = typeof currentVariantKey === "string" && currentVariantKey.length > 0;

  // Filter window rounds according to variant scope
  let scopedRounds = windowRounds;
  let variantLabel = "Scope: mixed window";

  if (isVariantScoped) {
    scopedRounds = windowRounds.filter((r) => r.variant_key === currentVariantKey);
    // Ensure the current round itself is part of the comparison window
    if (!scopedRounds.some((r) => r.session_id === row.session_id)) {
      scopedRounds = [row, ...scopedRounds];
    }
    const shortKey = currentVariantKey.slice(0, 8);
    variantLabel = `Variant: ${shortKey}`;
  } else {
    if (!scopedRounds.some((r) => r.session_id === row.session_id)) {
      scopedRounds = [row, ...scopedRounds];
    }
    variantLabel = "Scope: mixed window";
  }

  const n = scopedRounds.length;
  const thisDuration = row.duration_ms ?? 0;

  // Collect durations for axis bounds and distribution calculations
  const durations = scopedRounds
    .map((r) => r.duration_ms)
    .filter((d): d is number => d !== null && d !== undefined)
    .sort((a, b) => a - b);

  const maxDuration = Math.max(...durations, thisDuration, 1000);
  const minDuration = durations.length > 0 ? durations[0] : 0;
  const canCharacterise = durations.length >= WINDOW_DISTRIBUTION_MIN_N;

  // Compute distribution metrics only if n >= WINDOW_DISTRIBUTION_MIN_N (#94)
  const median = canCharacterise && durations.length > 0
    ? durations[Math.floor(durations.length / 2)]
    : null;
  const p95 = canCharacterise && durations.length > 0
    ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
    : null;
  const max = canCharacterise && durations.length > 0
    ? durations[durations.length - 1]
    : null;

  // Percentage position of this round on the wall-clock axis
  const thisPositionPct = Math.min(100, Math.max(0, (thisDuration / maxDuration) * 100));

  return (
    <Card data-testid="window-comparison-panel">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>This round against its window</CardTitle>
        <div className="flex items-center gap-2">
          {/* Variant scope is prominently named on the panel (#94 ruling) */}
          <Badge variant="outline" className="font-mono text-xs" data-testid="variant-scope">
            {variantLabel}
          </Badge>
          {/* n is on the panel, not in a tooltip (#94 ruling) */}
          <Badge variant="default" className="font-mono text-xs" data-testid="window-n">
            n = {n}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Wall clock ruler */}
        <div className="flex justify-between items-center text-xs text-muted-foreground font-mono">
          <span>0ms</span>
          <span>{formatDuration(Math.round(maxDuration / 2))}</span>
          <span>{formatDuration(maxDuration)}</span>
        </div>

        {/* 1D Strip track */}
        <div className="relative w-full h-12 bg-muted/30 rounded border border-border/40 flex items-center px-1">
          {/* Light marks for each round in the window */}
          {scopedRounds.map((r, idx) => {
            const d = r.duration_ms ?? 0;
            const pct = Math.min(100, Math.max(0, (d / maxDuration) * 100));
            const isThisRound = r.session_id === row.session_id;
            if (isThisRound) return null; // Rendered prominently separately
            return (
              <div
                key={`${r.session_id}-${idx}`}
                className="absolute w-0.5 h-6 bg-muted-foreground/40 hover:bg-foreground transition-all pointer-events-none"
                style={{ left: `${pct}%` }}
                data-testid="window-mark"
                data-duration={d}
              />
            );
          })}

          {/* Highlighted marker for THIS round (#94 ruling) */}
          <div
            className="absolute z-10 flex flex-col items-center -translate-x-1/2 transition-all"
            style={{ left: `${thisPositionPct}%` }}
            data-testid="this-round-mark"
            data-duration={thisDuration}
          >
            <div className="w-1.5 h-8 bg-primary rounded-full shadow-sm" />
            <span className="text-[10px] font-mono font-semibold bg-background/90 text-primary px-1 rounded border border-primary/40 whitespace-nowrap mt-0.5">
              this round ({formatDuration(thisDuration)})
            </span>
          </div>
        </div>

        {/* Distribution statistics or low-n notice */}
        {!canCharacterise ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/30">
            <span className="font-medium" data-testid="low-n-notice">
              n too small to characterise
            </span>
            <span>threshold: {WINDOW_DISTRIBUTION_MIN_N} rounds</span>
          </div>
        ) : (
          <div
            className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-border/30 text-xs font-mono"
            data-testid="window-distribution"
          >
            <div>
              <dt className="text-[11px] text-muted-foreground">Min</dt>
              <dd className="tabular font-medium">{formatDuration(minDuration)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Median (p50)</dt>
              <dd className="tabular font-medium">{median !== null ? formatDuration(median) : "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">p95</dt>
              <dd className="tabular font-medium">{p95 !== null ? formatDuration(p95) : "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Max</dt>
              <dd className="tabular font-medium">{max !== null ? formatDuration(max) : "—"}</dd>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
