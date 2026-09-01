import { Fragment, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  createExpandedRowModel,
  createSortedRowModel,
  rowExpandingFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

import { Timestamp } from "@/components/Timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RoundRow } from "@/api/types";
import { LIST_RATE_EQUIVALENT } from "@/honesty/thresholds";
import {
  formatCount,
  formatDuration,
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
});

const helper = createColumnHelper<typeof features, RoundRow>();

/** sortUndefined never fires on a null, and every nullable column in the store is null. */
function nullToUndefined(value: number | null): number | undefined {
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
        className="tabular whitespace-nowrap underline-offset-4 hover:underline"
      >
        <Timestamp iso={row.original.recorded_at} />
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
}

export function RoundsTable({ rows, sorting, onSortingChange }: RoundsTableProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const data = useMemo(() => rows, [rows]);

  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.session_id,
    getRowCanExpand: () => true,
    state: { sorting, expanded },
    onSortingChange: (updater) =>
      onSortingChange(typeof updater === "function" ? updater(sorting) : updater),
    onExpandedChange: (updater) =>
      setExpanded((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        return typeof next === "boolean" ? {} : next;
      }),
  });

  return (
    <Table>
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
    </Table>
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
