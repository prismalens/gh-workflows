import { useMemo } from "react";
import { createRoute } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { z } from "zod";

import { useRoundsQuery, useSummaryQuery } from "@/api/queries";
import type { RoundRow } from "@/api/types";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { PRsTable } from "@/features/prs/PRsTable";
import {
  comparePRsByAttention,
  filterPRsByState,
  groupRoundsByPR,
} from "@/features/prs/prs";
import { RangeControl } from "@/honesty/RangeControl";
import { applyRange, standardRangeSchema } from "@/honesty/range";
import { rootRoute } from "./root";

const EMPTY_ROWS: RoundRow[] = [];

const prsSearchSchema = z.object({
  range: standardRangeSchema,
  repository: z.string().min(1).optional().catch(undefined),
  state: z.string().min(1).optional().catch("open"),
  sort: z.string().min(1).optional().catch("attention"),
  dir: z.enum(["asc", "desc"]).optional().catch("asc"),
});

export const prsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prs",
  validateSearch: prsSearchSchema,
  component: PRsPage,
});

const STATE_OPTIONS = ["open", "all", "merged", "closed"];

function PRsPage() {
  const search = prsRoute.useSearch();
  const navigate = prsRoute.useNavigate();

  const now = useMemo(() => new Date(), []);
  const summary = useSummaryQuery();
  const rounds = useRoundsQuery(
    { range: search.range, repository: search.repository },
    now,
  );

  const fetched = rounds.data?.rows ?? EMPTY_ROWS;
  const truncated = rounds.data?.next_cursor != null;
  const windowed = useMemo(
    () => applyRange(fetched, search.range, now, truncated),
    [fetched, search.range, now, truncated],
  );

  const allPrs = useMemo(() => groupRoundsByPR(windowed.rows), [windowed.rows]);
  const openCount = useMemo(
    () => allPrs.filter((pr) => pr.state === "open").length,
    [allPrs],
  );

  const filteredPrs = useMemo(
    () => filterPRsByState(allPrs, search.state),
    [allPrs, search.state],
  );

  const sorting: SortingState = search.sort
    ? [{ id: search.sort, desc: search.dir === "desc" }]
    : [{ id: "attention", desc: false }];

  const sortedPrs = useMemo(() => {
    const list = [...filteredPrs];
    const firstSort = sorting[0];
    if (!firstSort || firstSort.id === "attention" || firstSort.id === "head_status") {
      list.sort(comparePRsByAttention);
      if (firstSort?.desc) list.reverse();
      return list;
    }
    return list;
  }, [filteredPrs, sorting]);

  const setSorting = (next: SortingState) => {
    const first = next[0];
    void navigate({
      search: (prev) => ({
        ...prev,
        sort: first?.id ?? "attention",
        dir: first ? (first.desc ? "desc" : "asc") : undefined,
      }),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Top filters */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Pull requests</h1>
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
          label="State"
          options={STATE_OPTIONS}
          value={search.state ?? "open"}
          onChange={(state) => void navigate({ search: (prev) => ({ ...prev, state }) })}
        />
      </div>

      {rounds.isPending ? (
        <LoadingRows rows={6} label="Loading pull requests" />
      ) : rounds.isError ? (
        <QueryError error={rounds.error} title="Could not load pull requests" />
      ) : (
        <div className="flex flex-col gap-3">
          {/* Subheader status bar */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-border/60 bg-muted/20 px-2 py-0.5 font-medium">
              repo: {search.repository ?? "all"}
            </span>
            <span className="rounded border border-border/60 bg-muted/20 px-2 py-0.5 font-medium">
              state: {search.state ?? "open"}
            </span>
            <span className="rounded border border-border/60 bg-muted/20 px-2 py-0.5 font-medium">
              needs: attention first
            </span>
            <span className="text-[11px] text-muted-foreground/80">
              sort: failed &gt; did-not-run &gt; threads-only &gt; reviewed
            </span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {search.state === "open" ? `${openCount} open PRs` : `${sortedPrs.length} PRs`}
            </span>
          </div>

          <PRsTable
            prs={sortedPrs}
            sorting={sorting}
            onSortingChange={setSorting}
          />

          <div className="text-[11px] text-muted-foreground">
            rounds column is by type: F full · I incremental · V verify (reads no code) · titles arrive with issue 04, findings counts with issue 08
          </div>
        </div>
      )}
    </div>
  );
}
