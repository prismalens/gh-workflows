import { ExternalLink } from "lucide-react";

import { parseLaneEventsByReason, parseUnaccountedRuns } from "@/api/blobs";
import type { HealthReportRow } from "@/api/types";
import { Timestamp } from "@/components/Timestamp";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Degraded } from "@/honesty/Degraded";
import { formatCount } from "@/lib/format";

function ingestLabel(row: HealthReportRow): string {
  if (row.ingest_auth === "oidc") {
    return row.repository_id !== null ? `OIDC, repository id ${row.repository_id}` : "OIDC";
  }
  return row.ingest_auth;
}

function UnaccountedCell({ row }: { row: HealthReportRow }) {
  const runs = parseUnaccountedRuns(row);
  if (runs === null) {
    return (
      <Degraded
        what="Unaccounted runs"
        reason="unreadable"
        detail={`${formatCount(row.runs_seen - row.runs_accounted)} by count; the run list did not parse.`}
      />
    );
  }
  if (runs.length === 0) return <span className="tabular">0</span>;
  // The table stores no run URL, so the link is built from the repository and run id.
  return (
    <details>
      <summary className="tabular cursor-pointer">{formatCount(runs.length)}</summary>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
        {runs.map((run) => (
          <li key={run.id} className="whitespace-nowrap">
            <a
              href={`https://github.com/${row.repository}/actions/runs/${run.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline"
            >
              {run.id} <ExternalLink className="size-3" />
            </a>{" "}
            <span className="text-muted-foreground">{run.conclusion}</span>{" "}
            <Timestamp iso={run.created_at} compact className="text-muted-foreground" />
          </li>
        ))}
      </ul>
    </details>
  );
}

function LaneEventsCell({ row }: { row: HealthReportRow }) {
  const reasons = parseLaneEventsByReason(row);
  if (reasons === null) {
    return <Degraded what="Lane events by reason" reason="unreadable" />;
  }
  if (reasons.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {reasons.map((entry) => (
        <Badge key={entry.key} variant="outline">
          {entry.key} {formatCount(entry.value)}
        </Badge>
      ))}
    </div>
  );
}

/**
 * One table row per health_reports row, newest window first. An oversize week
 * arrives as several tiling rows and a re-run inserts again; both are facts
 * about what was reported, so none is merged (#179, answer 5).
 */
export function WeeklyHealth({ rows, truncated }: { rows: HealthReportRow[]; truncated: boolean }) {
  return (
    <div className="flex flex-col gap-3" data-testid="weekly-health">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Window</TableHead>
                <TableHead>Runs seen</TableHead>
                <TableHead>Accounted</TableHead>
                <TableHead>Unaccounted</TableHead>
                <TableHead>Startup failures</TableHead>
                <TableHead>Lane events</TableHead>
                <TableHead>Findings swept</TableHead>
                <TableHead>Share</TableHead>
                <TableHead>Ingest</TableHead>
                <TableHead>Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-testid="health-row">
                  <TableCell className="tabular whitespace-nowrap">
                    <Timestamp iso={row.window_start} compact /> to{" "}
                    <Timestamp iso={row.window_end} compact />
                  </TableCell>
                  <TableCell className="tabular">{formatCount(row.runs_seen)}</TableCell>
                  <TableCell className="tabular">{formatCount(row.runs_accounted)}</TableCell>
                  <TableCell>
                    <UnaccountedCell row={row} />
                  </TableCell>
                  <TableCell className="tabular">
                    {row.startup_failures > 0 ? (
                      <Badge variant="warning">{formatCount(row.startup_failures)}</Badge>
                    ) : (
                      "0"
                    )}
                  </TableCell>
                  <TableCell>
                    <LaneEventsCell row={row} />
                  </TableCell>
                  <TableCell className="tabular">{formatCount(row.findings_swept)}</TableCell>
                  <TableCell>{row.share}</TableCell>
                  <TableCell className="whitespace-nowrap">{ingestLabel(row)}</TableCell>
                  <TableCell className="tabular whitespace-nowrap">
                    <Timestamp iso={row.received_at} compact />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Every report is listed as it arrived. A week too large for one report arrives as several
        rows, and a re-run adds another.
        {truncated ? ` Only the newest ${formatCount(rows.length)} reports are shown.` : ""}
      </p>
    </div>
  );
}
