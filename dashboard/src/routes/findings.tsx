import { useEffect, useMemo, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { z } from "zod";

import { useFindingsQuery, usePRsQuery, useSummaryQuery } from "@/api/queries";
import type { FindingRow, PrRow } from "@/api/types";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { DEFAULT_PAGE_SIZE, TablePager, type PageSize } from "@/components/TablePager";
import { DivergenceList } from "@/features/findings/DivergenceList";
import { FindingsHonestyHeader } from "@/features/findings/FindingsHonestyHeader";
import { FindingsTable } from "@/features/findings/FindingsTable";
import { FindingsTiles, FixLoopQualitySection } from "@/features/findings/FindingsTiles";
import {
  FATE_FILTER_OPTIONS,
  incompletePrKeys,
  matchesFateFilter,
  matchesFindingSearch,
  type FateFilterValue,
} from "@/features/findings/findings";
import { formatCount } from "@/lib/format";
import { rootRoute } from "./root";

const SEARCH_DEBOUNCE_MS = 200;

const EMPTY_FINDINGS: FindingRow[] = [];
const EMPTY_PRS: PrRow[] = [];

const PR_STATE_OPTIONS = ["open", "all", "merged", "closed"];

const findingsSearchSchema = z.object({
  q: z.string().min(1).optional().catch(undefined),
  fate: z
    .enum(["never-answered", "pushback-open", "resolved-by-human", "self-graded", "fix-cited"])
    .optional()
    .catch(undefined),
  repository: z.string().min(1).optional().catch(undefined),
  pr_state: z.enum(["open", "all", "merged", "closed"]).optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  size: z
    .union([z.literal(25), z.literal(50), z.literal(100)])
    .optional()
    .catch(undefined),
});

export const findingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/findings",
  validateSearch: findingsSearchSchema,
  component: FindingsPage,
});

function prStateFor(row: FindingRow, prsByKey: Map<string, PrRow>): string | undefined {
  return prsByKey.get(`${row.repository}#${row.pr_number}`)?.state ?? undefined;
}

function FindingsPage() {
  const search = findingsRoute.useSearch();
  const navigate = findingsRoute.useNavigate();

  const summary = useSummaryQuery();
  const findings = useFindingsQuery({ repository: search.repository });
  const prs = usePRsQuery({ repository: search.repository });

  const fetched = findings.data?.rows ?? EMPTY_FINDINGS;
  const prRows = prs.data?.rows ?? EMPTY_PRS;
  const truncated = findings.data?.next_cursor != null;

  const prsByKey = useMemo(() => {
    const map = new Map<string, PrRow>();
    for (const row of prRows) map.set(`${row.repository}#${row.pr_number}`, row);
    return map;
  }, [prRows]);

  // "In window": repository (already sent to the Worker) plus PR state, which
  // is what the tiles and the divergence list are computed over. "Matching"
  // below adds the fate chip and the free-text search (#111 table contract).
  const windowRows = useMemo(() => {
    if (!search.pr_state) return fetched;
    return fetched.filter((row) => {
      const state = prStateFor(row, prsByKey);
      return search.pr_state === "all" ? true : state === search.pr_state;
    });
  }, [fetched, search.pr_state, prsByKey]);

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

  const matchingRows = useMemo(() => {
    let list = windowRows;
    if (search.fate) {
      const fate = search.fate as FateFilterValue;
      list = list.filter((row) => matchesFateFilter(row, fate));
    }
    if (search.q) {
      const needle = search.q.toLowerCase();
      list = list.filter((row) => matchesFindingSearch(row, needle));
    }
    return list;
  }, [windowRows, search.fate, search.q]);

  const isFiltered = Boolean(search.fate || search.q);

  const pageSize: PageSize = search.size ?? DEFAULT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(matchingRows.length / pageSize));
  const page = Math.min(Math.max(search.page ?? 1, 1), pageCount);
  const pageRows = matchingRows.slice((page - 1) * pageSize, page * pageSize);

  const incomplete = useMemo(() => incompletePrKeys(fetched), [fetched]);

  const windowLabel = truncated
    ? "the most recent findings read (a throttle cut the sweep short)"
    : "every recorded finding";

  const isLoading = findings.isPending;
  const error = findings.error;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Findings</h1>
      </div>

      <FindingsHonestyHeader />

      {isLoading ? (
        <LoadingRows rows={6} label="Loading findings" />
      ) : error ? (
        <QueryError error={error} title="Could not load findings" />
      ) : (
        <div className="flex flex-col gap-6">
          <FindingsTiles rows={windowRows} prs={prRows} windowLabel={windowLabel} />

          <FixLoopQualitySection rows={windowRows} />

          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold tracking-tight">Divergence</h2>
            <p className="text-xs text-muted-foreground">
              Where the lane's own verify verdict disagrees with GitHub's resolved state. Never an
              aggregate rate: the lane's own automation can drive resolution through the workflow
              token, so agreement would be partly mechanical.
            </p>
            <DivergenceList rows={windowRows} />
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-tight">All findings</h2>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="search"
                value={searchDraft}
                onChange={(e) => commitSearch(e.target.value)}
                placeholder="Search path, header, repository, PR number"
                aria-label="Search findings"
                className="h-8 min-w-[240px] rounded-md border border-border bg-transparent px-3 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              />
              <FilterChips
                label="Fate"
                options={FATE_FILTER_OPTIONS}
                value={search.fate}
                onChange={(fate) =>
                  void navigate({
                    search: (prev) => ({
                      ...prev,
                      fate: fate as typeof prev.fate,
                      page: undefined,
                    }),
                  })
                }
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
                label="PR state"
                options={PR_STATE_OPTIONS}
                value={search.pr_state}
                onChange={(pr_state) =>
                  void navigate({
                    search: (prev) => ({
                      ...prev,
                      pr_state: pr_state as typeof prev.pr_state,
                      page: undefined,
                    }),
                  })
                }
              />
            </div>

            <FindingsTable
              rows={pageRows}
              incompletePrKeys={incomplete}
              // "No findings match the selected filters" is only true when a fate or search
              // filter actually narrowed the rows. With neither active, an empty result is an
              // empty window, not a filter excluding anything (finding this pass).
              emptyMessage={
                isFiltered
                  ? undefined
                  : "No findings recorded in the loaded window. This is an absence of findings, " +
                    "not proof every reviewed pull request here was clean."
              }
            />

            <TablePager
              page={page}
              pageCount={pageCount}
              pageSize={pageSize}
              total={matchingRows.length}
              windowTotal={isFiltered ? windowRows.length : undefined}
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

            {truncated && (
              <p className="text-[11px] text-muted-foreground">
                the {formatCount(fetched.length)} most recent findings are shown; a throttle cut
                the underlying sweep short for at least one pull request.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
