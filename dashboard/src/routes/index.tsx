import { useCallback, useMemo, useRef, useState } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { z } from "zod";

import {
  useAttentionQuery,
  useChangesQuery,
  useRoundsQuery,
  useSummaryQuery,
} from "@/api/queries";
import { MAX_LIMIT } from "@/api/client";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  activityBand,
  changesInWindow,
  roundsPerDay,
  roundTypesPresent,
  tokensPerDay,
  wallClockPoints,
} from "@/features/overview/activity";
import { attentionCards } from "@/features/overview/attention";
import { AttentionFeed } from "@/features/overview/AttentionFeed";
import {
  RoundsPerDayChart,
  TokenCompositionChart,
  WallClockScatterChart,
} from "@/features/overview/charts";
import { VerdictStrip } from "@/features/overview/VerdictStrip";
import { RoundsTable } from "@/features/rounds/RoundsTable";
import { aggregateRounds, tokenSums } from "@/honesty/aggregate";
import { Degraded } from "@/honesty/Degraded";
import { meanMetric } from "@/honesty/metrics";
import { RangeControl } from "@/honesty/RangeControl";
import { applyRange, rangeSchema, type RangeKey } from "@/honesty/range";
import { CountTile, Tile } from "@/honesty/Tile";
import { aggregateMode, TileStrip } from "@/honesty/TileStrip";
import { PER_DAY_RATE_MIN_ROUNDS } from "@/honesty/thresholds";
import { verdictMix } from "@/honesty/verdict";
import {
  formatCount,
  formatDuration,
  formatMultiplier,
  formatPercent,
  formatTokens,
} from "@/lib/format";
import { rootRoute } from "./root";

const overviewSearchSchema = z.object({
  range: rangeSchema,
  repository: z.string().min(1).optional().catch(undefined),
});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: overviewSearchSchema,
  component: OverviewPage,
});

const EMPTY_ROWS = Object.freeze([]) as never[];

/**
 * The altitude is ruled (#46). The first screenful is throughput and adoption:
 * the activity band, then the verdict strip directly under it, because the strip
 * is what makes those counts trustworthy. Diagnostics are demoted below the fold:
 * lane health, the two charts, then the attention feed.
 *
 * Counts headline at every volume, because a count is true at any n. Only the
 * supporting line switches on volume, at PER_DAY_RATE_MIN_ROUNDS.
 */
function OverviewPage() {
  const search = indexRoute.useSearch();
  const navigate = indexRoute.useNavigate();
  // Only the thin-window round table sorts, and only here, so this is local state
  // rather than a search param the rest of the overview has no use for.
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const selectedMarkerIdRef = useRef<string | null>(null);
  selectedMarkerIdRef.current = selectedMarkerId;

  // Pinned per render pass, so the window boundary cannot drift between the band
  // and the charts on the same screen.
  const now = useMemo(() => new Date(), []);
  const filters = { range: search.range, repository: search.repository };

  const summary = useSummaryQuery();
  const rounds = useRoundsQuery(filters, now);
  const attention = useAttentionQuery(filters, now);
  const changes = useChangesQuery();

  const fetched = rounds.data?.rows ?? EMPTY_ROWS;
  const fetchedChanges = useMemo(() => changes.data?.rows ?? EMPTY_ROWS, [changes.data?.rows]);
  const truncated = rounds.data?.next_cursor != null;
  const windowed = useMemo(
    () => applyRange(fetched, search.range, now, truncated, fetchedChanges),
    [fetched, search.range, now, truncated, fetchedChanges],
  );

  const windowChanges = useMemo(
    () => changesInWindow(fetchedChanges, search.range, now, windowed.rows, search.repository),
    [fetchedChanges, search.range, now, windowed.rows, search.repository],
  );

  const band = useMemo(() => activityBand(windowed.rows), [windowed.rows]);
  const types = useMemo(() => roundTypesPresent(band), [band]);
  const perDay = useMemo(
    () => roundsPerDay(windowed.rows, types, windowChanges),
    [windowed.rows, types, windowChanges],
  );
  const tokenDays = useMemo(
    () => tokensPerDay(windowed.rows, windowChanges),
    [windowed.rows, windowChanges],
  );
  const scatter = useMemo(() => wallClockPoints(windowed.rows), [windowed.rows]);
  const mix = useMemo(() => verdictMix(windowed.rows), [windowed.rows]);
  const stats = useMemo(() => aggregateRounds(windowed.rows), [windowed.rows]);
  const tokens = useMemo(() => tokenSums(windowed.rows), [windowed.rows]);
  const billable = useMemo(
    () =>
      meanMetric(
        windowed.rows.map((row) =>
          row.input_tokens === null || row.output_tokens === null
            ? null
            : row.input_tokens + row.output_tokens,
        ),
      ),
    [windowed.rows],
  );

  const handleMarkerClick = useCallback(
    (changeId: string) => {
      const current = selectedMarkerIdRef.current;
      if (current === null) {
        setSelectedMarkerId(changeId);
      } else if (current === changeId) {
        setSelectedMarkerId(null);
      } else {
        const nextRange: RangeKey = `marker:${current}..${changeId}`;
        setSelectedMarkerId(null);
        void navigate({ search: (prev) => ({ ...prev, range: nextRange }) });
      }
    },
    [navigate],
  );

  const countByType = Object.fromEntries(band.byType.map((entry) => [entry.type, entry.rounds]));
  if (band.untypedRounds > 0) countByType.untyped = band.untypedRounds;

  const perDayRate = band.rounds >= PER_DAY_RATE_MIN_ROUNDS;
  const allTimeRounds = summary.data?.rows ?? null;
  const reposEverPosted = summary.data?.repositories.length ?? null;

  if (rounds.isPending) {
    return <LoadingRows label="Loading the overview" />;
  }
  if (rounds.isError) {
    return <QueryError error={rounds.error} title="Could not load the overview" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Overview</h1>
        <RangeControl
          value={search.range}
          onChange={(range) => {
            setSelectedMarkerId(null);
            void navigate({ search: (prev) => ({ ...prev, range }) });
          }}
        />
        <FilterChips
          label="Repository"
          options={summary.data?.repositories ?? []}
          value={search.repository}
          onChange={(repository) => {
            setSelectedMarkerId(null);
            void navigate({ search: (prev) => ({ ...prev, repository }) });
          }}
        />
      </div>

      {selectedMarkerId && (
        <div data-testid="marker-selection-banner" className="text-xs text-muted-foreground">
          Selected marker:{" "}
          <span className="font-medium text-foreground">
            {fetchedChanges.find((c) => c.id === selectedMarkerId)?.name ?? selectedMarkerId}
          </span>
          . Click a second marker to set a range, or click again to deselect.
        </div>
      )}

      {band.rounds === 0 ? (
        <Alert variant="muted">
          <AlertTitle>No rounds in range</AlertTitle>
          <AlertDescription>
            Nothing was recorded over {windowed.label}
            {search.repository ? ` for ${search.repository}` : ""}. Not zeros: either nothing ran,
            or nothing was recorded.{" "}
            {/* Functional form, not an object: an object replaces the whole search
                state, and this link would then widen the repository filter as well
                as the range while claiming to widen only time. */}
            <Link
              to="/"
              search={(prev) => ({ ...prev, range: "all" })}
              className="underline underline-offset-4"
            >
              Widen to all time
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {/* The activity band: throughput and adoption, above everything else. */}
          <section
            data-testid="activity-band"
            className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4"
          >
            <CountTile
              label="PRs reviewed"
              count={band.prsReviewed}
              approximate="Distinct pull requests whose head the round type says was read. A verify round reads no code and counts no PR, and a round recorded without a type cannot be attributed, so this undercounts and never overcounts."
              detail={`distinct pull requests over ${windowed.label}`}
              support={
                perDayRate
                  ? `${formatCount(round2(band.prsReviewed / band.daysSpanned))}/day mean over ${band.daysSpanned} ${band.daysSpanned === 1 ? "day" : "days"}`
                  : allTimeRounds !== null
                    ? `under ${PER_DAY_RATE_MIN_ROUNDS} rounds in the window, so the cumulative renders here, never a per-day rate: ${formatCount(allTimeRounds)} rounds all time`
                    : undefined
              }
            />
            <CountTile
              label="Review rounds"
              count={band.rounds}
              detail={
                band.byType.length === 0
                  ? "no round in this window carries a type"
                  : band.byType.map((entry) => `${entry.rounds} ${entry.type}`).join(" · ")
              }
              support={
                perDayRate
                  ? `${formatCount(round2(band.rounds / band.daysSpanned))}/day mean · the n behind every tile below`
                  : `the n behind every tile below${allTimeRounds !== null ? ` · ${formatCount(allTimeRounds)} all time` : ""}`
              }
            />
            <CountTile
              label="Repositories"
              count={band.reposActive}
              detail={
                reposEverPosted !== null
                  ? `active this window, of ${formatCount(reposEverPosted)} that have ever posted`
                  : "active this window"
              }
              support="not of the repositories configured: no fleet registry exists to give that denominator"
            />
            <RoundsPerDayChart
              data={perDay}
              types={types}
              countByType={countByType}
              changes={windowChanges}
              selectedMarkerId={selectedMarkerId}
              onMarkerClick={handleMarkerClick}
            />
          </section>

          {/* Directly under the band: what makes those counts trustworthy. */}
          <VerdictStrip mix={mix} windowLabel={windowed.label} />

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-tight">Lane health</h2>
            <TileStrip n={band.rounds} windowLabel={windowed.label}>
              <Tile
                label="Mean wall clock"
                metric={stats.meanWallClock}
                format={formatDuration}
                hint="end to end, per round"
              />
              <Tile
                label="p95 wall clock"
                metric={stats.p95WallClock}
                format={formatDuration}
                hint="the slow tail operators actually wait on"
              />
              <Tile
                label="Permission denials per round"
                metric={stats.denialsPerRound}
                format={formatCount}
                hint="a denial is a tool the lane asked for and did not get"
              />
              <Tile
                label="Caching multiplier"
                metric={stats.cachingMultiplier}
                format={formatMultiplier}
                hint="uncached-equivalent over billed-equivalent input, rate-free"
              />
              <Tile
                label="Cache hit rate"
                metric={stats.cacheHitRate}
                format={formatPercent}
                hint="cache reads over all input tokens"
              />
              <Tile
                label="Billable tokens"
                metric={billable}
                format={formatTokens}
                hint="input plus output, per round. A token count is a count, not money."
              />
            </TileStrip>
            {/* Under TILES_MIN_ROUNDS the ruling replaces aggregates with the rounds
                themselves, and TileStrip's notice names a table below it, so the
                table it names has to be here. */}
            {aggregateMode(band.rounds) === "table-instead" && (
              <RoundsTable rows={windowed.rows} sorting={sorting} onSortingChange={setSorting} />
            )}
            <Degraded
              what="Silent rate"
              reason="unbuilt"
              detail="A round that posted nothing still records a row, so a silent round is indistinguishable here from one that spoke. Naming it needs the verdict column (issue 02)."
            />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-tight">
              Diagnostics{" "}
              <span className="font-normal text-muted-foreground">
                · the drill-down continues on{" "}
                <Link
                  to="/rounds"
                  search={{ range: search.range, repository: search.repository }}
                  className="underline underline-offset-4"
                >
                  rounds
                </Link>
              </span>
            </h2>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <TokenCompositionChart
                data={tokenDays}
                totals={{
                  input: tokens.input,
                  cacheCreation: tokens.create,
                  cacheRead: tokens.read,
                }}
                changes={windowChanges}
                selectedMarkerId={selectedMarkerId}
                onMarkerClick={handleMarkerClick}
              />
              <WallClockScatterChart
                points={scatter}
                changes={windowChanges}
                selectedMarkerId={selectedMarkerId}
                onMarkerClick={handleMarkerClick}
              />
            </div>
          </section>

          {attention.isPending ? (
            <LoadingRows rows={3} label="Loading the attention feed" />
          ) : attention.isError ? (
            <QueryError error={attention.error} title="Could not load the attention feed" />
          ) : (
            <AttentionFeed
              cards={attentionCards(attention.data?.rows ?? EMPTY_ROWS)}
              scanned={attention.data?.rows.length ?? 0}
              windowLabel={windowed.label}
            />
          )}

          {truncated && (
            <p className="text-xs text-muted-foreground">
              Every count above is over the most recent {MAX_LIMIT} rounds the read route returns
              in one page. Older rounds exist and are in none of them.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Two decimals, so a per-day rate does not render as 262.00000000000006. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
