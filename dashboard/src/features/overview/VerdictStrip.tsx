import { Card, CardContent } from "@/components/ui/card";
import { Approximate } from "@/honesty/Degraded";
import { VERDICT_COPY, type VerdictMix } from "@/honesty/verdict";
import { formatCount, formatPercent } from "@/lib/format";
import { seriesColor } from "./charts";

const SEGMENTS = [
  { state: "reviewed", color: seriesColor("full", 0) },
  { state: "unknown", color: "var(--muted-foreground)" },
] as const;

export interface VerdictStripProps {
  mix: VerdictMix;
  windowLabel: string;
}

/**
 * Sits directly under the activity band because it is what makes the bold counts
 * above it trustworthy: it says how many of those rounds are ones we can claim
 * read a head. Two states, permanently, until the verdict column lands (#46).
 */
export function VerdictStrip({ mix, windowLabel }: VerdictStripProps) {
  return (
    <Card className="min-w-0">
      <CardContent className="flex flex-col gap-2 p-4" data-testid="verdict-strip">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Verdict mix, as far as it is recorded
          </span>
          <span className="flex items-center gap-2">
            <Approximate why="Two states, not four. The lane's posted verdict is not a column yet: issue 02." />
            <span className="tabular text-xs text-muted-foreground">n = {formatCount(mix.n)}</span>
          </span>
        </div>

        {mix.n === 0 ? (
          <span className="text-sm text-muted-foreground">no rounds in range</span>
        ) : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded-sm">
              {SEGMENTS.map((segment) => (
                <div
                  key={segment.state}
                  style={{
                    backgroundColor: segment.color,
                    width: `${(mix[segment.state] / mix.n) * 100}%`,
                  }}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
              {SEGMENTS.map((segment) => (
                <span
                  key={segment.state}
                  className="inline-flex items-center gap-1.5 text-muted-foreground"
                  title={VERDICT_COPY[segment.state].explain}
                >
                  <span
                    aria-hidden
                    className="size-2.5 rounded-[2px]"
                    style={{ backgroundColor: segment.color }}
                  />
                  {VERDICT_COPY[segment.state].label}{" "}
                  <span className="tabular font-medium text-foreground">
                    {formatCount(mix[segment.state])}
                  </span>
                  <span className="tabular">
                    ({formatPercent(mix[segment.state] / mix.n)})
                  </span>
                </span>
              ))}
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Over {windowLabel}. Reviewed is claimed from the round type, which says the lane read
          the head. Unknown is a verify round or a round recorded without a type, not a failure.
        </p>
      </CardContent>
    </Card>
  );
}
