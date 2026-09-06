import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
} from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";

import { Timestamp } from "@/components/Timestamp";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ATTENTION_RANKS } from "./headStatus";
import { HeadStatusChip } from "./HeadStatusChip";
import type { PRSummary } from "./prs";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

const helper = createColumnHelper<typeof features, PRSummary>();

const columns = helper.columns([
  helper.accessor("number", {
    id: "pr",
    header: "PR",
    cell: ({ row }) => (
      <div className="flex items-center gap-2 max-w-[420px] truncate">
        <Link
          to="/prs/$owner/$repo/$number"
          params={{
            owner: row.original.owner,
            repo: row.original.repo,
            number: String(row.original.number),
          }}
          className="font-mono text-xs font-medium text-primary hover:underline shrink-0"
        >
          {row.original.repo}#{row.original.number}
        </Link>
        <span className="text-xs text-foreground/90 truncate" title={row.original.title}>
          {row.original.title}
        </span>
      </div>
    ),
  }),
  helper.accessor("author", {
    header: "Author",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">{row.original.author}</span>
    ),
  }),
  helper.accessor("state", {
    header: "State",
    cell: ({ row }) => (
      <span
        className={`inline-block rounded px-1.5 py-0.5 text-[10.5px] font-medium border ${
          row.original.state === "open"
            ? "border-emerald-600/40 text-emerald-500 bg-emerald-500/10"
            : "border-muted-foreground/30 text-muted-foreground bg-muted/20"
        }`}
      >
        {row.original.state}
      </span>
    ),
  }),
  helper.accessor((row) => ATTENTION_RANKS[row.headStatus.state], {
    id: "head_status",
    header: "Head status",
    cell: ({ row }) => <HeadStatusChip status={row.original.headStatus} />,
  }),
  helper.accessor("compactRounds", {
    id: "rounds",
    header: "Rounds",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.compactRounds}
      </span>
    ),
  }),
  helper.display({
    id: "open_findings",
    header: "Open findings",
    cell: () => (
      <span
        className="text-xs text-muted-foreground"
        title="Open findings count arrives with issue 08"
      >
        —
      </span>
    ),
  }),
  helper.accessor("lastRoundAt", {
    id: "last_round",
    header: "Last round",
    cell: ({ row }) => (
      <span className="tabular text-xs text-muted-foreground">
        <Timestamp iso={row.original.lastRoundAt} />
      </span>
    ),
  }),
  helper.accessor("lastModel", {
    id: "model",
    header: "Model",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.lastModel ?? "—"}
      </span>
    ),
  }),
  helper.display({
    id: "actions",
    header: () => null,
    cell: ({ row }) =>
      row.original.url ? (
        <a
          href={row.original.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
        >
          gh <ExternalLink className="size-3" />
        </a>
      ) : null,
  }),
]);

export interface PRsTableProps {
  prs: PRSummary[];
  sorting: SortingState;
  onSortingChange: (next: SortingState) => void;
}

export function PRsTable({ prs, sorting, onSortingChange }: PRsTableProps) {
  const data = useMemo(() => prs, [prs]);

  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.id,
    state: { sorting },
    onSortingChange: (updater) =>
      onSortingChange(typeof updater === "function" ? updater(sorting) : updater),
  });

  return (
    <div className="rounded-md border border-border bg-card">
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
                        className="inline-flex items-center gap-1 hover:text-foreground text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <table.FlexRender header={header} />
                        <span aria-hidden className="tabular">
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                        </span>
                      </button>
                    ) : (
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <table.FlexRender header={header} />
                      </div>
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground text-xs">
                No pull requests match the selected filters.
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
