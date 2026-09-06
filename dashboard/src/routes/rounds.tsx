import { useEffect, useMemo, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { z } from "zod";

import { MAX_LIMIT } from "@/api/client";
import { downloadCsv } from "@/api/csv";
import { distinctRoundTypes, useRoundsQuery, useSummaryQuery } from "@/api/queries";
import type { RoundRow } from "@/api/types";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { DEFAULT_PAGE_SIZE, TablePager, type PageSize } from "@/components/TablePager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { decodeHeadStatus } from "@/features/prs/headStatus";
import { RoundsTable } from "@/features/rounds/RoundsTable";
import { RangeControl } from "@/honesty/RangeControl";
import { applyRange, standardRangeSchema } from "@/honesty/range";
import { rootRoute } from "./root";

const SEARCH_DEBOUNCE_MS = 200;

const roundsSearchSchema = z.object({
  range: standardRangeSchema,
  repository: z.string().min(1).optional().catch(undefined),
  round_type: z.string().min(1).optional().catch(undefined),
  verdict: z.string().min(1).optional().catch(undefined),
  model: z.string().min(1).optional().catch(undefined),
  q: z.string().min(1).optional().catch(undefined),
  sort: z.string().min(1).optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  size: z
    .union([z.literal(25), z.literal(50), z.literal(100)])
    .optional()
    .catch(undefined),
});

export const roundsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rounds",
  validateSearch: roundsSearchSchema,
  component: RoundsPage,
});

/** The decoded verdict labels present in the window, for the Verdict chip group (#141). */
function distinctVerdictLabels(rows: RoundRow[]): string[] {
  const labels = new Set<string>();
  for (const row of rows) {
    if (row.verdict_kind === null) continue;
    labels.add(decodeHeadStatus(row).label);
  }
  return [...labels].sort();
}

function distinctModels(rows: RoundRow[]): string[] {
  return [...new Set(rows.map((row) => row.model).filter((m): m is string => !!m))].sort();
}

function matchesSearch(row: RoundRow, needle: string): boolean {
  return (
    row.repository.toLowerCase().includes(needle) ||
    (row.pr_number !== null && String(row.pr_number).includes(needle)) ||
    row.session_id.toLowerCase().includes(needle) ||
    (row.head_sha ?? "").toLowerCase().includes(needle)
  );
}

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
  const roundTypes = useMemo(() => distinctRoundTypes(fetched), [fetched]);
  const verdictOptions = useMemo(() => distinctVerdictLabels(windowed.rows), [windowed.rows]);
  const modelOptions = useMemo(() => distinctModels(windowed.rows), [windowed.rows]);

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
    let list = windowed.rows;
    if (search.verdict) {
      list = list.filter(
        (row) => row.verdict_kind !== null && decodeHeadStatus(row).label === search.verdict,
      );
    }
    if (search.model) {
      list = list.filter((row) => row.model === search.model);
    }
    if (search.q) {
      const needle = search.q.toLowerCase();
      list = list.filter((row) => matchesSearch(row, needle));
    }
    return list;
  }, [windowed.rows, search.verdict, search.model, search.q]);

  const isFiltered = Boolean(search.verdict || search.model || search.q);

  const pageSize: PageSize = search.size ?? DEFAULT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(matchingRows.length / pageSize));
  const page = Math.min(Math.max(search.page ?? 1, 1), pageCount);

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
        page: undefined,
      }),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Rounds</h1>
        <RangeControl
          value={search.range}
          onChange={(range) =>
            void navigate({ search: (prev) => ({ ...prev, range, page: undefined }) })
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

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => commitSearch(e.target.value)}
          placeholder="Search repository, PR, session, sha"
          aria-label="Search rounds"
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
          label="Type"
          options={roundTypes}
          value={search.round_type}
          onChange={(round_type) =>
            void navigate({ search: (prev) => ({ ...prev, round_type, page: undefined }) })
          }
        />
        <FilterChips
          label="Verdict"
          options={verdictOptions}
          value={search.verdict}
          onChange={(verdict) =>
            void navigate({ search: (prev) => ({ ...prev, verdict, page: undefined }) })
          }
        />
        <FilterChips
          label="Model"
          options={modelOptions}
          value={search.model}
          onChange={(model) =>
            void navigate({ search: (prev) => ({ ...prev, model, page: undefined }) })
          }
        />
      </div>

      {rounds.isPending ? (
        <LoadingRows />
      ) : rounds.isError ? (
        <QueryError error={rounds.error} />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Over {windowed.label}, {windowed.rows.length} rounds.
          </p>

          {windowed.rows.length === 0 ? (
            <Alert variant="muted">
              <AlertTitle>No rounds in range</AlertTitle>
              <AlertDescription>
                No round was recorded over {windowed.label}
                {search.repository ? ` for ${search.repository}` : ""}
                {search.round_type ? ` of type ${search.round_type}` : ""}.
              </AlertDescription>
            </Alert>
          ) : matchingRows.length === 0 ? (
            <Alert variant="muted">
              <AlertTitle>No rounds match</AlertTitle>
              <AlertDescription>
                Nothing in {windowed.label} matches the current search and filters.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <RoundsTable
                rows={matchingRows}
                sorting={sorting}
                onSortingChange={setSorting}
                pagination={{ pageIndex: page - 1, pageSize }}
                showFooter
              />
              <TablePager
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                total={matchingRows.length}
                windowTotal={isFiltered ? windowed.rows.length : undefined}
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

          {truncated && (
            <p className="text-xs text-muted-foreground">
              Showing the most recent {MAX_LIMIT} rounds the read route returns in one page. Older
              rounds exist and are not counted above.
            </p>
          )}
        </>
      )}
    </div>
  );
}

const EMPTY_ROWS = Object.freeze([]) as never[];
