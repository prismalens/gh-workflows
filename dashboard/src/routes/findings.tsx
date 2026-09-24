import { useMemo } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import { z } from "zod";

import {
  useFindingsQuery,
  useFleetFindingsQuery,
  usePRsQuery,
} from "@/api/queries";
import type { FindingRow, PrRow } from "@/api/types";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { DEFAULT_PAGE_SIZE, TablePager, type PageSize } from "@/components/TablePager";
import { DivergenceList } from "@/features/findings/DivergenceList";
import { FindingsHonestyHeader } from "@/features/findings/FindingsHonestyHeader";
import { FacetRail, type Facet } from "@/components/FacetRail";
import { FilterBar } from "@/components/FilterBar";
import { Button } from "@/components/ui/button";
import { AGE_BUCKETS, facetCounts, filterFindings, sortFindings, type FindingFilters } from "@/features/findings/explore";
import { FindingPeek, FindingsList } from "@/features/findings/FindingsExplorer";
import type { FilterKey, FilterToken } from "@/features/filters/grammar";
import { FindingsTiles, FixLoopQualitySection } from "@/features/findings/FindingsTiles";
import { FleetFindingsView } from "@/features/findings/FleetFindingsView";
import {
  FATE_FILTER_OPTIONS,
  incompletePrKeys,
  matchesFateFilter,
  prKey,
  type FateFilterValue,
} from "@/features/findings/findings";
import { formatCount } from "@/lib/format";
import { rootRoute } from "./root";

const EMPTY_FINDINGS: FindingRow[] = [];
const EMPTY_PRS: PrRow[] = [];

const PR_STATE_OPTIONS = ["open", "all", "merged", "closed"];
const SEVERITY_VALUES = ["critical", "major", "minor", "nitpick", "none"] as const;
type SeverityValue = (typeof SEVERITY_VALUES)[number];
const asSeverity = (v: string | undefined): SeverityValue | undefined =>
  (SEVERITY_VALUES as readonly string[]).includes(v ?? "") ? (v as SeverityValue) : undefined;

const findingsSearchSchema = z.object({
  // `counts` is the Fleet altitude, read from /api/fleet/findings; absent is the
  // Investigate altitude, which reads rows (#185 F3).
  view: z.enum(["counts"]).optional().catch(undefined),
  q: z.string().min(1).optional().catch(undefined),
  fate: z
    .enum(["never-answered", "pushback-open", "resolved-by-human", "self-graded", "fix-cited"])
    .optional()
    .catch(undefined),
  repository: z.string().min(1).optional().catch(undefined),
  pr_state: z.enum(["open", "all", "merged", "closed"]).optional().catch(undefined),
  path: z.string().min(1).optional().catch(undefined),
  age: z.string().min(1).optional().catch(undefined),
  sev: z.enum(SEVERITY_VALUES).optional().catch(undefined),
  pr: z.string().min(1).optional().catch(undefined),
  sort: z.enum(["oldest", "newest"]).optional().catch(undefined),
  group: z.enum(["none"]).optional().catch(undefined),
  sel: z.string().min(1).optional().catch(undefined),
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
  return search.view === "counts" ? <FindingsCounts /> : <FindingsRows />;
}

function ViewSwitch({ view }: { view: "counts" | undefined }) {
  const base = "rounded-md px-2 py-1 text-xs";
  const active = `${base} bg-secondary text-secondary-foreground`;
  const idle = `${base} text-muted-foreground hover:text-foreground`;
  return (
    <div role="group" aria-label="View" className="flex items-center gap-1">
      <Link
        to="/findings"
        search={{ view: "counts" }}
        className={view === "counts" ? active : idle}
        aria-current={view === "counts" ? "page" : undefined}
      >
        Counts
      </Link>
      <Link
        to="/findings"
        search={{}}
        className={view === undefined ? active : idle}
        aria-current={view === undefined ? "page" : undefined}
      >
        Rows
      </Link>
    </div>
  );
}

function FindingsCounts() {
  const search = findingsRoute.useSearch();
  const navigate = findingsRoute.useNavigate();
  const prState = search.pr_state === "all" ? undefined : search.pr_state;
  const fleet = useFleetFindingsQuery({ pr_state: prState });
  const repositories = (fleet.data?.repositories ?? []).map((r) => r.repository);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Findings</h1>
        <ViewSwitch view="counts" />
      </div>

      <FindingsHonestyHeader />

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          label="Repository"
          options={repositories}
          value={search.repository}
          onChange={(repository) => void navigate({ search: (prev) => ({ ...prev, repository }) })}
        />
        <FilterChips
          label="PR state"
          options={PR_STATE_OPTIONS}
          value={search.pr_state}
          onChange={(pr_state) =>
            void navigate({
              search: (prev) => ({ ...prev, pr_state: pr_state as typeof prev.pr_state }),
            })
          }
        />
      </div>

      {fleet.isPending ? (
        <LoadingRows rows={6} label="Loading finding counts" />
      ) : fleet.isError ? (
        <QueryError error={fleet.error} title="Could not load finding counts" />
      ) : (
        <FleetFindingsView data={fleet.data} repository={search.repository} prState={prState} />
      )}
    </div>
  );
}

const VIEWS: { key: string; label: string; fate: FateFilterValue | undefined }[] = [
  { key: "reply", label: "Needs a reply", fate: "never-answered" },
  { key: "pushback", label: "Pushback open", fate: "pushback-open" },
  { key: "self", label: "Self-graded", fate: "self-graded" },
  { key: "fix", label: "Fix cited", fate: "fix-cited" },
  { key: "all", label: "All", fate: undefined },
];

const FINDING_KEYS: FilterKey[] = ["repo", "fate", "state", "path", "age", "sev", "pr"];

type FindingsSearch = z.infer<typeof findingsSearchSchema>;

function tokensFromSearch(search: FindingsSearch): FilterToken[] {
  const pairs: [FilterKey, string | undefined][] = [
    ["repo", search.repository],
    ["fate", search.fate],
    ["state", search.pr_state],
    ["path", search.path],
    ["age", search.age],
    ["sev", search.sev],
    ["pr", search.pr],
  ];
  return pairs.flatMap(([key, value]) => (value ? [{ key, value }] : []));
}

function searchFromTokens(tokens: FilterToken[], text: string): Partial<FindingsSearch> {
  const get = (key: FilterKey) => tokens.find((t) => t.key === key)?.value;
  const fate = get("fate");
  const state = get("state");
  return {
    repository: get("repo"),
    fate: (FATE_FILTER_OPTIONS as string[]).includes(fate ?? "") ? (fate as FateFilterValue) : undefined,
    pr_state: PR_STATE_OPTIONS.includes(state ?? "") ? (state as FindingsSearch["pr_state"]) : undefined,
    path: get("path"),
    age: get("age"),
    sev: asSeverity(get("sev")),
    pr: get("pr"),
    q: text.trim() || undefined,
    page: undefined,
  };
}

const SEVERITY_LABELS: Record<string, string> = {
  critical: "critical",
  major: "major",
  minor: "minor",
  nitpick: "nitpick",
  none: "not stated",
};

function FindingsRows() {
  const search = findingsRoute.useSearch();
  const navigate = findingsRoute.useNavigate();
  const now = useMemo(() => new Date(), []);

  // The Worker narrows by exact repository only; a partial repo: token filters here.
  const exactRepo = search.repository?.includes("/") ? search.repository : undefined;
  const findings = useFindingsQuery({ repository: exactRepo });
  const prs = usePRsQuery({ repository: exactRepo });

  const fetched = findings.data?.rows ?? EMPTY_FINDINGS;
  const prRows = prs.data?.rows ?? EMPTY_PRS;
  const truncated = findings.data?.next_cursor != null;

  const prsByKey = useMemo(() => {
    const map = new Map<string, PrRow>();
    for (const row of prRows) map.set(`${row.repository}#${row.pr_number}`, row);
    return map;
  }, [prRows]);
  const prStateOf = useMemo(() => (row: FindingRow) => prStateFor(row, prsByKey), [prsByKey]);

  const filters: FindingFilters = {
    repository: search.repository,
    fate: search.fate as FateFilterValue | undefined,
    prState: search.pr_state,
    path: search.path,
    age: search.age,
    sev: search.sev,
    pr: search.pr,
    q: search.q?.toLowerCase(),
  };

  // Tiles and divergence read the window before fate, age and text narrow it (#111).
  const windowRows = useMemo(
    () => filterFindings(fetched, { repository: search.repository, prState: search.pr_state }, prStateOf, now),
    [fetched, search.repository, search.pr_state, prStateOf, now],
  );
  const matchingRows = useMemo(
    () => sortFindings(filterFindings(fetched, filters, prStateOf, now), search.sort ?? "oldest"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetched, prStateOf, now, search.repository, search.fate, search.pr_state, search.path, search.age, search.sev, search.pr, search.q, search.sort],
  );
  const counts = useMemo(
    () => facetCounts(fetched, filters, prStateOf, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetched, prStateOf, now, search.repository, search.fate, search.pr_state, search.path, search.age, search.sev, search.pr, search.q],
  );
  const viewCounts = useMemo(() => {
    const base = filterFindings(fetched, { ...filters, fate: undefined }, prStateOf, now);
    return Object.fromEntries(
      VIEWS.map((v) => [v.key, v.fate ? base.filter((r) => matchesFateFilter(r, v.fate!)).length : base.length]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched, prStateOf, now, search.repository, search.pr_state, search.path, search.age, search.sev, search.pr, search.q]);

  const isFiltered = Boolean(search.fate || search.q || search.path || search.age || search.sev || search.pr);
  const groupByPr = search.group !== "none";

  const pageSize: PageSize = search.size ?? DEFAULT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(matchingRows.length / pageSize));
  const page = Math.min(Math.max(search.page ?? 1, 1), pageCount);
  const pageRows = matchingRows.slice((page - 1) * pageSize, page * pageSize);

  const incomplete = useMemo(() => incompletePrKeys(fetched), [fetched]);
  const selectedRow = search.sel ? fetched.find((r) => r.thread_node_id === search.sel) : undefined;
  const siblings = selectedRow
    ? fetched.filter((r) => prKey(r) === prKey(selectedRow) && r.thread_node_id !== selectedRow.thread_node_id)
    : [];

  const windowLabel = truncated ? "the most recent findings read" : "every recorded finding";
  const set = (patch: Partial<FindingsSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  const select = (sel: string | undefined) => set({ sel });

  const repoOptions = Object.keys(counts.repository).sort();
  if (search.repository && !repoOptions.includes(search.repository)) repoOptions.push(search.repository);
  const facets: Facet[] = [
    {
      key: "fate",
      title: "Fate",
      selected: search.fate,
      onSelect: (v) => set({ fate: v as FateFilterValue | undefined, page: undefined }),
      options: FATE_FILTER_OPTIONS.map((f) => ({ value: f, label: f.replace(/-/g, " "), count: counts.fate[f] ?? 0 })),
    },
    {
      key: "repository",
      title: "Repository",
      selected: search.repository,
      onSelect: (v) => set({ repository: v, page: undefined }),
      options: repoOptions.map((r) => ({ value: r, label: r, count: counts.repository[r] ?? 0 })),
    },
    {
      key: "age",
      title: "Age",
      selected: search.age,
      onSelect: (v) => set({ age: v, page: undefined }),
      options: AGE_BUCKETS.map((b) => ({ value: b.value, label: b.label, count: counts.age[b.value] ?? 0 })),
    },
    {
      key: "sev",
      title: "Severity",
      selected: search.sev,
      onSelect: (v) => set({ sev: asSeverity(v), page: undefined }),
      options: Object.entries(SEVERITY_LABELS).map(([value, label]) => ({ value, label, count: counts.sev[value] ?? 0 })),
    },
    {
      key: "prState",
      title: "PR state",
      selected: search.pr_state,
      onSelect: (v) => set({ pr_state: v as FindingsSearch["pr_state"], page: undefined }),
      options: ["open", "merged", "closed"].map((s) => ({ value: s, label: s, count: counts.prState[s] ?? 0 })),
    },
  ];

  const activeView = VIEWS.find((v) => v.fate === search.fate)?.key;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Findings</h1>
        <ViewSwitch view={undefined} />
        <FindingsHonestyHeader />
      </div>

      {findings.isPending ? (
        <LoadingRows rows={6} label="Loading findings" />
      ) : findings.error ? (
        <QueryError error={findings.error} title="Could not load findings" />
      ) : (
        <div className={selectedRow ? "grid gap-5 xl:grid-cols-[210px_minmax(0,1fr)_380px]" : "grid gap-5 lg:grid-cols-[210px_minmax(0,1fr)]"}>
          <FacetRail
            facets={facets}
            onClear={
              isFiltered || search.repository || search.pr_state
                ? () =>
                    void navigate({
                      search: (prev) => ({ view: prev.view, size: prev.size, group: prev.group, sort: prev.sort }),
                      replace: true,
                    })
                : undefined
            }
          />

          <div className="flex min-w-0 flex-col gap-3">
            <div role="tablist" aria-label="Views" className="flex flex-wrap items-center gap-1">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  aria-selected={activeView === v.key}
                  onClick={() => set({ fate: v.fate as FindingsSearch["fate"], page: undefined, sel: undefined })}
                  className={
                    activeView === v.key
                      ? "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-semibold"
                      : "inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                  }
                >
                  {v.label}
                  <span className="tabular text-[11px] text-muted-foreground">{viewCounts[v.key] ?? 0}</span>
                </button>
              ))}
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => set({ group: groupByPr ? "none" : undefined })}>
                  Group: {groupByPr ? "PR" : "none"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => set({ sort: (search.sort ?? "oldest") === "oldest" ? "newest" : undefined })}
                >
                  Sort: {search.sort ?? "oldest"} first
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void navigator.clipboard?.writeText(window.location.href)}
                  title="Every filter, sort and view is in the address"
                >
                  Copy link
                </Button>
              </div>
            </div>

            <FilterBar
              keys={FINDING_KEYS}
              tokens={tokensFromSearch(search)}
              text={search.q ?? ""}
              onChange={({ tokens, text }) =>
                void navigate({ search: (prev) => ({ ...prev, ...searchFromTokens(tokens, text) }) })
              }
            />

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                <b className="text-foreground tabular">{formatCount(matchingRows.length)}</b> of{" "}
                {formatCount(fetched.length)} findings
              </span>
              <span>j k move · Enter opens the PR · Esc closes the panel</span>
            </div>

            <FindingsList
              rows={pageRows}
              selected={search.sel}
              onSelect={select}
              groupByPr={groupByPr}
              incompletePrKeys={incomplete}
              now={now}
              emptyMessage={
                isFiltered
                  ? "No findings match these filters."
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
              onPageChange={(nextPage) => set({ page: nextPage <= 1 ? undefined : nextPage })}
              onPageSizeChange={(size) =>
                set({ size: size === DEFAULT_PAGE_SIZE ? undefined : size, page: undefined })
              }
            />

            {truncated && (
              <p className="text-[11px] text-muted-foreground">
                the {formatCount(fetched.length)} most recent findings are shown.
              </p>
            )}

            <details className="rounded-md border border-border bg-card px-4 py-3 text-xs" open={false}>
              <summary className="cursor-pointer font-semibold">Fix-loop quality and divergence</summary>
              <div className="mt-4 flex flex-col gap-6">
                <FindingsTiles rows={windowRows} prs={prRows} windowLabel={windowLabel} />
                <FixLoopQualitySection rows={windowRows} />
                <div className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold tracking-tight">Divergence</h2>
                  <p className="text-muted-foreground">
                    Where the lane's own verify verdict disagrees with GitHub's resolved state.
                  </p>
                  <DivergenceList rows={windowRows} />
                </div>
              </div>
            </details>
          </div>

          {selectedRow && <FindingPeek row={selectedRow} siblings={siblings} onSelect={select} now={now} />}
        </div>
      )}
    </div>
  );
}
