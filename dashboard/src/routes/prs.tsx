import { useEffect, useMemo, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { z } from "zod";

import { usePRsQuery, useRoundsQuery, useSummaryQuery } from "@/api/queries";
import type { RoundRow } from "@/api/types";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { DEFAULT_PAGE_SIZE, TablePager, type PageSize } from "@/components/TablePager";
import { PRsTable } from "@/features/prs/PRsTable";
import { formatCount } from "@/lib/format";
import { type HeadStatusState } from "@/features/prs/headStatus";
import {
  comparePRsByAttention,
  enrichPRs,
  filterPRsByState,
  groupRoundsByPR,
  type PRSummary,
} from "@/features/prs/prs";
import { RangeControl } from "@/honesty/RangeControl";
import { applyRange, standardRangeSchema } from "@/honesty/range";
import { rootRoute } from "./root";

const SEARCH_DEBOUNCE_MS = 200;

const EMPTY_ROWS: RoundRow[] = [];

const HEAD_STATUS_OPTIONS: HeadStatusState[] = [
  "failed",
  "did-not-run",
  "threads-only",
  "reviewed",
];

const prsSearchSchema = z.object({
  range: standardRangeSchema,
  repository: z.string().min(1).optional().catch(undefined),
  // #136 reverses finding 3943781321: the default is now "All" states, not "open".
  // An explicit state param still filters exactly as before.
  state: z.enum(["open", "all", "merged", "closed"]).optional().catch(undefined),
  head_status: z.enum(["failed", "did-not-run", "threads-only", "reviewed"]).optional().catch(undefined),
  q: z.string().min(1).optional().catch(undefined),
  sort: z.string().min(1).optional().catch("attention"),
  dir: z.enum(["asc", "desc"]).optional().catch("asc"),
  page: z.number().int().min(1).optional().catch(undefined),
  size: z
    .union([z.literal(25), z.literal(50), z.literal(100)])
    .optional()
    .catch(undefined),
});

export const prsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prs",
  validateSearch: prsSearchSchema,
  component: PRsPage,
});

const STATE_OPTIONS = ["open", "all", "merged", "closed"];

function matchesSearch(pr: PRSummary, needle: string): boolean {
  return (
    pr.repository.toLowerCase().includes(needle) ||
    String(pr.number).includes(needle) ||
    pr.title.toLowerCase().includes(needle) ||
    pr.author.toLowerCase().includes(needle)
  );
}

function PRsPage() {
  const search = prsRoute.useSearch();
  const navigate = prsRoute.useNavigate();

  const now = useMemo(() => new Date(), []);
  const summary = useSummaryQuery();
  const rounds = useRoundsQuery(
    { range: search.range, repository: search.repository },
    now,
  );
  const prs = usePRsQuery({ repository: search.repository });

  const fetched = rounds.data?.rows ?? EMPTY_ROWS;
  const truncated = rounds.data?.next_cursor != null;
  const windowed = useMemo(
    () => applyRange(fetched, search.range, now, truncated),
    [fetched, search.range, now, truncated],
  );

  // The base set is PRs with a round in this window (#141); a prs row for a PR
  // outside it is dropped rather than added, so enrichment only ever fills in.
  const allPrs = useMemo(
    () => enrichPRs(groupRoundsByPR(windowed.rows), prs.data?.rows ?? []),
    [windowed.rows, prs.data],
  );

  // "in window": range plus repository and state, which already narrowed the
  // set before this lane's work. "matching" adds head status and search (#141).
  const windowPrs = useMemo(
    () => filterPRsByState(allPrs, search.state),
    [allPrs, search.state],
  );

  const [searchDraft, setSearchDraft] = useState(search.q ?? "");
  useEffect(() => setSearchDraft(search.q ?? ""), [search.q]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const commitSearch = (next: string) => {
    setSearchDraft(next);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const term = next.trim();
      void navigate({
        search: (prev) => ({ ...prev, q: term === "" ? undefined : term, page: undefined }),
      });
    }, SEARCH_DEBOUNCE_MS);
  };
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const matchingPrs = useMemo(() => {
    let list = windowPrs;
    if (search.head_status) {
      list = list.filter((pr) => pr.headStatus.state === search.head_status);
    }
    if (search.q) {
      const needle = search.q.toLowerCase();
      list = list.filter((pr) => matchesSearch(pr, needle));
    }
    return list;
  }, [windowPrs, search.head_status, search.q]);

  const isFiltered = Boolean(search.head_status || search.q);

  const sorting: SortingState = search.sort
    ? [{ id: search.sort, desc: search.dir === "desc" }]
    : [{ id: "attention", desc: false }];

  const sortedPrs = useMemo(() => {
    const list = [...matchingPrs];
    const firstSort = sorting[0];
    if (!firstSort || firstSort.id === "attention" || firstSort.id === "head_status") {
      list.sort(comparePRsByAttention);
      if (firstSort?.desc) list.reverse();
      return list;
    }
    return list;
  }, [matchingPrs, sorting]);

  const pageSize: PageSize = search.size ?? DEFAULT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(sortedPrs.length / pageSize));
  const page = Math.min(Math.max(search.page ?? 1, 1), pageCount);

  const setSorting = (next: SortingState) => {
    const first = next[0];
    void navigate({
      search: (prev) => ({
        ...prev,
        sort: first?.id ?? "attention",
        dir: first ? (first.desc ? "desc" : "asc") : undefined,
        page: undefined,
      }),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Pull requests</h1>
        <RangeControl
          value={search.range}
          onChange={(range) =>
            void navigate({ search: (prev) => ({ ...prev, range, page: undefined }) })
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => commitSearch(e.target.value)}
          placeholder="Search repository, PR, title, author"
          aria-label="Search pull requests"
          className="h-8 min-w-[240px] rounded-md border border-border bg-transparent px-3 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        />
        <FilterChips
          label="Repository"
          options={summary.data?.repositories ?? []}
          value={search.repository}
          onChange={(repository) =>
            void navigate({ search: (prev) => ({ ...prev, repository, page: undefined }) })
          }
        />
        <FilterChips
          label="State"
          options={STATE_OPTIONS}
          value={search.state}
          onChange={(state) => {
            const validState =
              state === "all" || state === "closed" || state === "merged" || state === "open"
                ? state
                : undefined;
            void navigate({ search: (prev) => ({ ...prev, state: validState, page: undefined }) });
          }}
        />
        <FilterChips
          label="Head status"
          options={HEAD_STATUS_OPTIONS}
          value={search.head_status}
          onChange={(head_status) => {
            const validState =
              head_status === "failed" ||
              head_status === "did-not-run" ||
              head_status === "threads-only" ||
              head_status === "reviewed"
                ? head_status
                : undefined;
            void navigate({
              search: (prev) => ({ ...prev, head_status: validState, page: undefined }),
            });
          }}
        />
      </div>

      {rounds.isPending ? (
        <LoadingRows rows={6} label="Loading pull requests" />
      ) : rounds.isError ? (
        <QueryError error={rounds.error} title="Could not load pull requests" />
      ) : (
        <div className="flex flex-col gap-3">
          {sortedPrs.length === 0 ? (
            <PRsTable prs={sortedPrs} sorting={sorting} onSortingChange={setSorting} />
          ) : (
            <>
              <PRsTable
                prs={sortedPrs}
                sorting={sorting}
                onSortingChange={setSorting}
                pagination={{ pageIndex: page - 1, pageSize }}
              />
              <TablePager
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                total={sortedPrs.length}
                windowTotal={isFiltered ? windowPrs.length : undefined}
                onPageChange={(nextPage) =>
                  void navigate({
                    search: (prev) => ({ ...prev, page: nextPage <= 1 ? undefined : nextPage }),
                  })
                }
                onPageSizeChange={(size) =>
                  void navigate({
                    search: (prev) => ({
                      ...prev,
                      size: size === DEFAULT_PAGE_SIZE ? undefined : size,
                      page: undefined,
                    }),
                  })
                }
              />
            </>
          )}

          {prs.data?.next_cursor != null && (
            <div className="text-[11px] text-muted-foreground">
              the {formatCount(prs.data.rows.length)} most recently updated pull requests are
              enriched from the prs table; older ones show the state at their last round.
            </div>
          )}

          <div className="text-[11px] text-muted-foreground">
            rounds column is by type: F full, I incremental, V verify, which reads no code. Open
            findings arrive with #111.
          </div>
        </div>
      )}
    </div>
  );
}
