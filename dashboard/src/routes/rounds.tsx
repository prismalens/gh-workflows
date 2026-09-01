import { useMemo } from "react";
import { createRoute } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { z } from "zod";

import { MAX_LIMIT } from "@/api/client";
import { downloadCsv } from "@/api/csv";
import { distinctRoundTypes, useRoundsQuery, useSummaryQuery } from "@/api/queries";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RoundsTable } from "@/features/rounds/RoundsTable";
import { aggregateRounds } from "@/honesty/aggregate";
import { RangeControl } from "@/honesty/RangeControl";
import { applyRange, rangeSchema } from "@/honesty/range";
import { Tile } from "@/honesty/Tile";
import { TileStrip } from "@/honesty/TileStrip";
import {
  formatCount,
  formatDuration,
  formatMultiplier,
  formatPercent,
} from "@/lib/format";
import { rootRoute } from "./root";

const roundsSearchSchema = z.object({
  range: rangeSchema,
  repository: z.string().min(1).optional().catch(undefined),
  round_type: z.string().min(1).optional().catch(undefined),
  sort: z.string().min(1).optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
});

export const roundsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rounds",
  validateSearch: roundsSearchSchema,
  component: RoundsPage,
});

function RoundsPage() {
  const search = roundsRoute.useSearch();
  const navigate = roundsRoute.useNavigate();

  // Pinned per render pass so the range boundary cannot drift between the tiles
  // and the table on the same screen.
  const now = useMemo(() => new Date(), []);

  const summary = useSummaryQuery();
  const rounds = useRoundsQuery(
    { range: search.range, repository: search.repository, roundType: search.round_type },
    now,
  );

  const fetched = rounds.data?.rows ?? EMPTY_ROWS;
  const truncated = rounds.data?.next_cursor != null;
  const windowed = useMemo(
    () => applyRange(fetched, search.range, now, truncated),
    [fetched, search.range, now, truncated],
  );
  const stats = useMemo(() => aggregateRounds(windowed.rows), [windowed.rows]);
  const roundTypes = useMemo(() => distinctRoundTypes(fetched), [fetched]);

  const sorting: SortingState = search.sort
    ? [{ id: search.sort, desc: search.dir === "desc" }]
    : [];

  const setSorting = (next: SortingState) => {
    const first = next[0];
    void navigate({
      search: (prev) => ({
        ...prev,
        sort: first?.id,
        dir: first ? (first.desc ? "desc" : "asc") : undefined,
      }),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Rounds</h1>
        <RangeControl
          value={search.range}
          onChange={(range) => void navigate({ search: (prev) => ({ ...prev, range }) })}
        />
        <FilterChips
          label="Repository"
          options={summary.data?.repositories ?? []}
          value={search.repository}
          onChange={(repository) =>
            void navigate({ search: (prev) => ({ ...prev, repository }) })
          }
        />
        <FilterChips
          label="Type"
          options={roundTypes}
          value={search.round_type}
          onChange={(round_type) =>
            void navigate({ search: (prev) => ({ ...prev, round_type }) })
          }
        />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={windowed.rows.length === 0}
          onClick={() => downloadCsv(windowed.rows)}
        >
          <Download className="size-4" /> Export CSV
        </Button>
      </div>

      {rounds.isPending ? (
        <LoadingRows />
      ) : rounds.isError ? (
        <QueryError error={rounds.error} />
      ) : (
        <>
          <TileStrip n={windowed.rows.length} windowLabel={windowed.label}>
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
              label="Cache hit rate"
              metric={stats.cacheHitRate}
              format={formatPercent}
              hint="cache reads over all input tokens"
            />
            <Tile
              label="Caching multiplier"
              metric={stats.cachingMultiplier}
              format={formatMultiplier}
              hint="uncached-equivalent over billed-equivalent input, rate-free"
            />
          </TileStrip>

          {windowed.rows.length === 0 ? (
            <Alert variant="muted">
              <AlertTitle>No rounds in range</AlertTitle>
              <AlertDescription>
                No round was recorded over {windowed.label}
                {search.repository ? ` for ${search.repository}` : ""}
                {search.round_type ? ` of type ${search.round_type}` : ""}.
              </AlertDescription>
            </Alert>
          ) : (
            <RoundsTable rows={windowed.rows} sorting={sorting} onSortingChange={setSorting} />
          )}

          {truncated && (
            <p className="text-xs text-muted-foreground">
              Showing the most recent {MAX_LIMIT} rounds the read route returns in one page. Older
              rounds exist and are not counted in any tile above.
            </p>
          )}
        </>
      )}
    </div>
  );
}

const EMPTY_ROWS = Object.freeze([]) as never[];
