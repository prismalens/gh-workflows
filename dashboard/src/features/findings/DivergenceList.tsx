import { ExternalLink } from "lucide-react";

import type { FindingRow } from "@/api/types";
import { Timestamp } from "@/components/Timestamp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { decodeDivergence, DIVERGENCE_COPY, divergentFindings } from "./findings";

/**
 * Rows where the lane's own verify verdict disagrees with GitHub's real
 * resolved state. Rendered as linked rows only, never an aggregate rate (#111):
 * the lane's own automation can drive resolution through the workflow token,
 * so an agreement rate would be partly mechanical. Disagreement is the one
 * signal here that means something regardless of who graded it.
 */
export function DivergenceList({ rows }: { rows: FindingRow[] }) {
  const divergent = divergentFindings(rows);

  if (divergent.length === 0) {
    return (
      <Alert variant="muted" data-testid="divergence-empty">
        <AlertTitle>No divergence in this window</AlertTitle>
        <AlertDescription>
          No finding's verify verdict disagrees with GitHub's resolved state, among the{" "}
          {rows.length} findings read.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card overflow-x-auto" data-testid="divergence-list">
      <Table className="[&_td]:py-1.5 [&_td]:text-xs [&_th]:h-8">
        <TableHeader>
          <TableRow>
            <TableHead>Pull request</TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Disagreement</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {divergent.map((row) => {
            const kind = decodeDivergence(row);
            return (
              <TableRow key={row.thread_node_id}>
                <TableCell className="whitespace-nowrap font-mono">
                  {row.repository}#{row.pr_number}
                </TableCell>
                <TableCell className="max-w-[220px] truncate font-mono" title={row.path ?? undefined}>
                  {row.path ?? "—"}
                  {row.original_line !== null ? `:${row.original_line}` : ""}
                </TableCell>
                <TableCell className="max-w-[360px] text-muted-foreground">
                  {kind ? DIVERGENCE_COPY[kind] : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp iso={row.thread_created_at} compact />
                </TableCell>
                <TableCell>
                  <a
                    href={`https://github.com/${row.repository}/pull/${row.pr_number}/files`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary hover:underline whitespace-nowrap"
                  >
                    View PR files on GitHub <ExternalLink className="size-3" />
                  </a>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
