import type { FleetFindingsCounts, FleetFindingsResponse } from "@/api/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { medianMetric, type Metric } from "@/honesty/metrics";
import { LOW_N_THRESHOLD } from "@/honesty/thresholds";
import { CountTile, Tile } from "@/honesty/Tile";
import { TileStrip } from "@/honesty/TileStrip";
import { formatCount, formatDuration, formatPercent } from "@/lib/format";
import { FateChip } from "./FateChip";
import { DIVERGENCE_COPY, FATE_COPY, type FindingFate } from "./findings";

const FATE_COUNT_KEYS: [FindingFate, keyof FleetFindingsCounts][] = [
  ["never-answered", "never_answered"],
  ["pushback-open", "pushback_open"],
  ["resolved-by-human", "resolved_by_human"],
  ["self-graded", "self_graded"],
];

/** The rows view's precise-attribution rate, from counts: fix-cited over every finding. */
function attributionMetric(counts: FleetFindingsCounts): Metric {
  if (counts.findings === 0) return { kind: "empty", n: 0 };
  return {
    kind: "value",
    value: counts.fix_cited / counts.findings,
    n: counts.findings,
    lowN: counts.findings < LOW_N_THRESHOLD,
  };
}

export interface FleetFindingsViewProps {
  data: FleetFindingsResponse;
  /** Narrows to one repository's counts; the response already carries each (#185). */
  repository: string | undefined;
}

/**
 * The Fleet altitude of Findings: the same tiles, fates and divergence as the
 * rows view, read as counts from /api/fleet/findings, so no header, body or
 * path reaches this view (#185 F3).
 */
export function FleetFindingsView({ data, repository }: FleetFindingsViewProps) {
  const repo = repository ? data.repositories.find((r) => r.repository === repository) : undefined;
  const counts = repository ? (repo ?? null) : data.totals;
  const hours = repository ? (repo?.review_to_merge_hours ?? []) : data.review_to_merge_hours;

  if (!counts) {
    return (
      <p className="text-sm text-muted-foreground">
        No findings recorded for {repository}. This is an absence of findings, not proof that
        every reviewed pull request there was clean.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <TileStrip
        n={counts.findings}
        windowLabel="every recorded finding"
        unit="findings"
        emptyExplanation="This is an absence of findings, not proof that every reviewed pull request here was clean."
      >
        <Tile
          label="Precise-attribution rate"
          metric={attributionMetric(counts)}
          format={formatPercent}
          hint="share of findings citing the exact fix commit"
        />
        <CountTile
          label="Never answered"
          count={counts.never_answered}
          detail="no reply on record, thread still open"
        />
        <Tile
          label="Review-to-merge latency"
          metric={medianMetric(hours)}
          format={(h) => formatDuration(h * 60 * 60 * 1000)}
          hint="attention metric: time from the first recorded finding to merge, not review quality"
        />
      </TileStrip>

      {counts.incomplete_prs > 0 && (
        <p className="text-xs text-muted-foreground">
          {formatCount(counts.incomplete_prs)} pull request(s) had a partial sweep, so the counts
          drawn from them are incomplete.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Fates</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fate</TableHead>
              <TableHead className="text-right">Findings</TableHead>
              <TableHead>Meaning</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {FATE_COUNT_KEYS.map(([fate, key]) => (
              <TableRow key={fate}>
                <TableCell>
                  <FateChip fate={fate} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(counts[key])}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{FATE_COPY[fate].explain}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell>fix cited</TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(counts.fix_cited)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                A fix commit is on record, whatever the thread's fate.
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Fix-loop quality (self-graded)
        </h3>
        <CountTile
          label="Still applies, per the lane's own verify round"
          count={counts.still_applies}
          detail="the lane's own verify round, not an independent check"
          support={`of ${formatCount(counts.findings)} findings`}
          className="max-w-xs"
        />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Divergence</h2>
        <p className="text-xs text-muted-foreground">
          Counts, never a rate: the lane's own automation can drive resolution through the
          workflow token, so agreement would be partly mechanical.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CountTile
            label="Verified fixed, still open"
            count={counts.verified_fixed_but_open}
            detail={DIVERGENCE_COPY["verified-fixed-but-open"]}
          />
          <CountTile
            label="Still applies, resolved"
            count={counts.not_addressed_but_resolved}
            detail={DIVERGENCE_COPY["not-addressed-but-resolved"]}
          />
        </div>
      </div>
    </div>
  );
}
