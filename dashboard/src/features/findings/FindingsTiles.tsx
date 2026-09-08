import type { FindingRow, PrRow } from "@/api/types";
import { CountTile, Tile } from "@/honesty/Tile";
import { TileStrip } from "@/honesty/TileStrip";
import { formatCount, formatDuration, formatPercent } from "@/lib/format";
import { neverAnsweredFindings, preciseAttributionMetric, stillAppliesFindings } from "./findings";
import { reviewToMergeLatencyMetric } from "./latency";

function formatHoursAsDuration(hours: number): string {
  return formatDuration(hours * 60 * 60 * 1000);
}

export interface FindingsTilesProps {
  rows: FindingRow[];
  prs: PrRow[];
  windowLabel: string;
}

/**
 * Precise-attribution rate, never-answered count, and review-to-merge latency
 * median, exactly the three tiles #111 rules. Wrapped in TileStrip keyed on the
 * finding count so a thin page of findings shows the table instead (#46's
 * sparse rule); each Tile still states its own n, which differs for latency
 * (merged pull requests, not findings).
 */
export function FindingsTiles({ rows, prs, windowLabel }: FindingsTilesProps) {
  const attribution = preciseAttributionMetric(rows);
  const neverAnswered = neverAnsweredFindings(rows);
  const latency = reviewToMergeLatencyMetric(rows, prs);

  return (
    <TileStrip
      n={rows.length}
      windowLabel={windowLabel}
      unit="findings"
      emptyExplanation="This is an absence of findings, not proof that every reviewed pull request here was clean."
    >
      <Tile
        label="Precise-attribution rate"
        metric={attribution}
        format={formatPercent}
        hint="share of findings citing the exact fix commit"
      />
      <CountTile
        label="Never answered"
        count={neverAnswered.length}
        detail="no reply on record, thread still open"
      />
      <Tile
        label="Review-to-merge latency"
        metric={latency}
        format={formatHoursAsDuration}
        hint="attention metric: time from the first recorded finding to merge, not review quality"
      />
    </TileStrip>
  );
}

/**
 * The lane's own verify round saying a fix attempt did not hold, exactly as
 * #47 originally filed it: a subheading of its own, labelled self-graded so it
 * is never mistaken for an independent count of unresolved work.
 */
export function FixLoopQualitySection({ rows }: { rows: FindingRow[] }) {
  const stillApplies = stillAppliesFindings(rows);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Fix-loop quality (self-graded)
      </h3>
      <CountTile
        label="Still applies, per the lane's own verify round"
        count={stillApplies.length}
        detail="the lane's own verify round, not an independent check"
        support={`of ${formatCount(rows.length)} findings read`}
        className="max-w-xs"
      />
    </div>
  );
}
