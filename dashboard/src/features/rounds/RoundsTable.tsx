import { Fragment, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  createExpandedRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RoundRow } from "@/api/types";
import { decodeHeadStatus } from "@/features/prs/headStatus";
import { HeadStatusChip } from "@/features/prs/HeadStatusChip";
import { meanMetric, numeric } from "@/honesty/metrics";
import { LIST_RATE_EQUIVALENT, LOW_N_THRESHOLD } from "@/honesty/thresholds";
import {
  formatCount,
  formatDuration,
  formatTimestamp,
  formatTimestampCompact,
  formatTokens,
  formatUsd,
  orDash,
  shortSha,
} from "@/lib/format";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

const helper = createColumnHelper<typeof features, RoundRow>();

/** sortUndefined never fires on a null, and every nullable column in the store is null. */
function nullToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

const columns = helper.columns([
  helper.display({
    id: "expander",
    header: () => <span className="sr-only">Expand</span>,
    cell: ({ row }) => (
      <Button
        variant="ghost"
        size="icon"
        aria-label={row.getIsExpanded() ? "Collapse round" : "Expand round"}
        aria-expanded={row.getIsExpanded()}
        onClick={row.getToggleExpandedHandler()}
      >
        {row.getIsExpanded() ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
      </Button>
    ),
  }),
  helper.accessor("recorded_at", {
    header: "Recorded",
    cell: ({ row }) => (
      <Link
        to="/rounds/$sessionId"
        params={{ sessionId: row.original.session_id }}
        search={{ at: row.original.recorded_at }}
        title={formatTimestamp(row.original.recorded_at)}
        className="tabular whitespace-nowrap underline-offset-4 hover:underline"
      >
        {formatTimestampCompact(row.original.recorded_at)}
      </Link>
    ),
  }),
  helper.accessor("repository", {
    header: "Repository",
    cell: ({ row }) => <span className="whitespace-nowrap">{row.original.repository}</span>,
  }),
  // Every nullable numeric column accesses through nullToUndefined: the store writes
  // null and sortUndefined only ever sees undefined, so without it a nulled column
  // sorts as the smallest value and a round with no wall clock reads as the fastest.
  helper.accessor((row) => nullToUndefined(row.pr_number), {
    id: "pr_number",
    sortUndefined: "last",
    header: "PR",
    cell: ({ row }) =>
      row.original.pr_url && row.original.pr_number !== null ? (
        <a
          href={row.original.pr_url}
          target="_blank"
          rel="noreferrer"
          className="tabular whitespace-nowrap underline-offset-4 hover:underline"
        >
          #{row.original.pr_number}
        </a>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  }),
  helper.accessor("round_type", {
    header: "Type",
    cell: ({ row }) =>
      row.original.round_type ? (
        <Badge variant="outline">{row.original.round_type}</Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  }),
  // Reuses features/prs/headStatus.ts's decode, so the rounds and PR pages never
  // disagree on a verdict label (#141). A null verdict_kind predates that field
  // entirely and is never run through the decode.
  helper.accessor(
    (row) => (row.verdict_kind === null ? undefined : decodeHeadStatus(row).label),
    {
      id: "verdict_kind",
      sortUndefined: "last",
      header: "Verdict",
      cell: ({ row }) =>
        row.original.verdict_kind === null ? (
          <span
            className="text-muted-foreground"
            title="This round predates the verdict fields."
          >
            —
          </span>
        ) : (
          <HeadStatusChip status={decodeHeadStatus(row.original)} />
        ),
    },
  ),
  helper.accessor((row) => nullToUndefined(row.model), {
    id: "model",
    sortUndefined: "last",
    header: "Model",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.model ?? "—"}
      </span>
    ),
  }),
  helper.accessor((row) => nullToUndefined(row.duration_ms), {
    id: "duration_ms",
    header: "Wall clock",
    sortUndefined: "last",
    cell: ({ row }) => (
      <span className="tabular">{orDash(row.original.duration_ms, formatDuration)}</span>
    ),
  }),
  helper.accessor((row) => nullToUndefined(row.num_turns), {
    id: "num_turns",
    sortUndefined: "last",
    header: "Turns",
    cell: ({ row }) => <span className="tabular">{orDash(row.original.num_turns)}</span>,
  }),
  helper.accessor((row) => nullToUndefined(row.permission_denials), {
    id: "permission_denials",
    sortUndefined: "last",
    header: "Denials",
    cell: ({ row }) => {
      const denials = row.original.permission_denials;
      if (denials === null) return <span className="text-muted-foreground">—</span>;
      return (
        <span className={denials > 0 ? "tabular text-[var(--warning)]" : "tabular"}>
          {formatCount(denials)}
        </span>
      );
    },
  }),
  helper.accessor(
    (row) =>
      row.input_tokens === null || row.output_tokens === null
        ? undefined
        : row.input_tokens + row.output_tokens,
    {
      id: "billable_tokens",
      sortUndefined: "last",
      header: "In + out",
      // Summing with ?? 0 would render a round that recorded no counts as the
      // lightest one on the page, which is the failure TileStrip exists to name.
      cell: ({ getValue }) => (
        <span className="tabular">{orDash(getValue() ?? null, formatTokens)}</span>
      ),
    },
  ),
  helper.accessor((row) => nullToUndefined(row.total_cost_usd), {
    id: "total_cost_usd",
    sortUndefined: "last",
    // Never promoted to a tile: on a subscription seat this is counterfactual and
    // only survives as a stable proxy for compute weight (#46).
    header: () => (
      <span className="whitespace-nowrap" title="total_cost_usd at published list rates">
        {LIST_RATE_EQUIVALENT}
      </span>
    ),
    cell: ({ row }) => (
      <span className="tabular">{orDash(row.original.total_cost_usd, formatUsd)}</span>
    ),
  }),
]);

export interface RoundsTableProps {
  rows: RoundRow[];
  sorting: SortingState;
  onSortingChange: (next: SortingState) => void;
  /** Externally controlled (URL-owned) pagination. Omit to render every row on one page. */
  pagination?: PaginationState;
  onPaginationChange?: (next: PaginationState) => void;
  /** The footer row of #141: n, mean and max wall clock, total denials over `rows`. */
  showFooter?: boolean;
}

const UNPAGINATED: PaginationState = { pageIndex: 0, pageSize: Infinity };

export function RoundsTable({
  rows,
  sorting,
  onSortingChange,
  pagination,
  onPaginationChange,
  showFooter = false,
}: RoundsTableProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [fallbackPagination, setFallbackPagination] = useState<PaginationState>(UNPAGINATED);
  const paginationState = pagination ?? fallbackPagination;
  const data = useMemo(() => rows, [rows]);

  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.session_id,
    getRowCanExpand: () => true,
    state: { sorting, expanded, pagination: paginationState },
    // The route owns page resets on filter/sort/range changes (#141); a second,
    // automatic reset here would fight that and hide the intended page.
    autoResetPageIndex: false,
    onSortingChange: (updater) =>
      onSortingChange(typeof updater === "function" ? updater(sorting) : updater),
    onExpandedChange: (updater) =>
      setExpanded((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        return typeof next === "boolean" ? {} : next;
      }),
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater(paginationState) : updater;
      (onPaginationChange ?? setFallbackPagination)(next);
    },
  });

  return (
    <Table className="[&_td]:py-1.5 [&_td]:text-xs [&_th]:h-8">
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => {
              const sorted = header.column.getIsSorted();
              return (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : header.column.getCanSort() ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <table.FlexRender header={header} />
                      <span aria-hidden className="tabular">
                        {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                      </span>
                    </button>
                  ) : (
                    <table.FlexRender header={header} />
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <Fragment key={row.id}>
            <TableRow>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
            {row.getIsExpanded() && (
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={row.getAllCells().length} className="p-4">
                  <ExpandedRound row={row.original} />
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
      {showFooter && (
        <TableFooter>
          <RoundsFooterRow rows={rows} columnCount={columns.length} />
        </TableFooter>
      )}
    </Table>
  );
}

/**
 * Rounds table footer (#141): n, mean and max wall clock, total denials, over
 * the filtered set the route hands in via `rows`, never the current page.
 * Honesty rule: n is printed, and there is deliberately no p95 here.
 */
function RoundsFooterRow({ rows, columnCount }: { rows: RoundRow[]; columnCount: number }) {
  const durations = useMemo(() => numeric(rows.map((row) => row.duration_ms)), [rows]);
  const mean = useMemo(() => meanMetric(rows.map((row) => row.duration_ms)), [rows]);
  const max = durations.length > 0 ? Math.max(...durations) : null;
  const denialCounts = useMemo(() => numeric(rows.map((row) => row.permission_denials)), [rows]);
  const totalDenials = denialCounts.reduce((sum, n) => sum + n, 0);

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={columnCount} className="text-xs text-muted-foreground">
        <span className="tabular" data-testid="rounds-footer-n">
          n = {formatCount(rows.length)}
        </span>
        <span className="mx-2">·</span>
        <span className="tabular">
          mean wall clock{" "}
          {mean.kind === "empty" ? "—" : formatDuration(mean.value)}
          {mean.kind === "value" && mean.lowN ? ` (n < ${LOW_N_THRESHOLD})` : ""}
        </span>
        <span className="mx-2">·</span>
        <span className="tabular">
          max wall clock {max === null ? "—" : formatDuration(max)}
        </span>
        <span className="mx-2">·</span>
        <span className="tabular">total denials {formatCount(totalDenials)}</span>
      </TableCell>
    </TableRow>
  );
}

function ExpandedRound({ row }: { row: RoundRow }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <Field label="Session">
          <span className="font-mono">{row.session_id}</span>
        </Field>
        <Field label="Head SHA">
          <span className="font-mono">{shortSha(row.head_sha)}</span>
        </Field>
        <Field label="Run attempt">{orDash(row.run_attempt)}</Field>
        <Field label="Model">{orDash(row.model)}</Field>
        <Field label="API time">{orDash(row.duration_api_ms, formatDuration)}</Field>
        <Field label="Cache read">{orDash(row.cache_read_input_tokens, formatTokens)}</Field>
        <Field label="Cache creation">
          {orDash(row.cache_creation_input_tokens, formatTokens)}
        </Field>
        <Field label="Reviewed">
          {row.changed_files === null && row.diff_lines === null
            ? "—"
            : `${orDash(row.changed_files)} files, ${orDash(row.diff_lines)} lines`}
        </Field>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link
            to="/rounds/$sessionId"
            params={{ sessionId: row.session_id }}
            search={{ at: row.recorded_at }}
          >
            Open round detail
          </Link>
        </Button>
        {row.run_url && (
          <Button asChild size="sm" variant="ghost">
            <a href={row.run_url} target="_blank" rel="noreferrer">
              Actions run <ExternalLink className="size-3.5" />
            </a>
          </Button>
        )}
        {row.pr_url && (
          <Button asChild size="sm" variant="ghost">
            <a href={row.pr_url} target="_blank" rel="noreferrer">
              Pull request <ExternalLink className="size-3.5" />
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular truncate">{children}</dd>
    </div>
  );
}
