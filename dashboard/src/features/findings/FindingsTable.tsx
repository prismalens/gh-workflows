import { ExternalLink } from "lucide-react";

import type { FindingRow } from "@/api/types";
import { Timestamp } from "@/components/Timestamp";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { decodeFate, fixCitation } from "./findings";
import { FateChip, FixCitedBadge } from "./FateChip";

/**
 * GitHub does not hand back a REST comment id for a GraphQL review thread node,
 * and review_findings stores no thread URL (#111's own scope: the sweep is
 * read-only over the GraphQL id). This links to the PR's own files tab, the
 * closest honest link this data supports, rather than guessing a comment anchor.
 */
function prFilesUrl(row: FindingRow): string {
  return `https://github.com/${row.repository}/pull/${row.pr_number}/files`;
}

export interface FindingsTableProps {
  rows: FindingRow[];
  /** PR keys whose sweep was cut short by a throttle; annotated per row (#111). */
  incompletePrKeys: Set<string>;
}

export function FindingsTable({ rows, incompletePrKeys }: FindingsTableProps) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
        No findings match the selected filters.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card overflow-x-auto">
      <Table className="[&_td]:py-1.5 [&_td]:text-xs [&_th]:h-8">
        <TableHeader>
          <TableRow>
            <TableHead>Fate</TableHead>
            <TableHead>Pull request</TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Header</TableHead>
            <TableHead>Body</TableHead>
            <TableHead>Fix</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const fate = decodeFate(row);
            const citation = fixCitation(row);
            const incomplete = incompletePrKeys.has(`${row.repository}#${row.pr_number}`);
            return (
              <TableRow key={row.thread_node_id}>
                <TableCell>
                  <FateChip fate={fate} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="font-mono text-xs">
                    {row.repository}#{row.pr_number}
                  </span>
                  {incomplete && (
                    <Badge
                      variant="warning"
                      className="ml-1.5"
                      title="This pull request's sweep was cut short by a throttle; its findings are a partial set."
                    >
                      partial sweep
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="max-w-[220px] truncate font-mono" title={row.path ?? undefined}>
                  {row.path ?? "—"}
                  {row.original_line !== null ? `:${row.original_line}` : ""}
                </TableCell>
                <TableCell className="max-w-[240px] truncate" title={row.header_raw ?? undefined}>
                  {row.header_raw ?? "—"}
                </TableCell>
                <TableCell className="max-w-[280px] truncate text-muted-foreground" title={row.body_excerpt ?? undefined}>
                  {row.body_excerpt ?? "—"}
                </TableCell>
                <TableCell>{citation ? <FixCitedBadge citation={citation} /> : "—"}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp iso={row.thread_created_at} compact />
                </TableCell>
                <TableCell>
                  <a
                    href={prFilesUrl(row)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary hover:underline whitespace-nowrap"
                  >
                    Open thread on GitHub <ExternalLink className="size-3" />
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
