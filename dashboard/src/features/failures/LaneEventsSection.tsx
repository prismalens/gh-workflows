import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Info } from "lucide-react";

import type { LaneEventRow } from "@/api/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { linkableRange, type RangeKey } from "@/honesty/range";
import { formatCount, formatTimestamp } from "@/lib/format";
import { summariseLaneEvents } from "./failures";
import { Sparkline } from "./Sparkline";

export interface LaneEventsSectionProps {
  events: LaneEventRow[];
  now: Date;
  range: RangeKey;
  repository?: string;
}

export function LaneEventsSection({ events, now, range, repository }: LaneEventsSectionProps) {
  const summaries = useMemo(() => summariseLaneEvents(events, now), [events, now]);

  return (
    <Card data-testid="section-lane-events">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <div>
          <CardTitle>5. Rounds that never happened</CardTitle>
          <p className="text-xs text-muted-foreground">
            Lane events recorded when review execution was skipped or halted.
          </p>
        </div>
        <span className="tabular text-xs text-muted-foreground">
          events = {formatCount(events.length)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px]">Reason</TableHead>
              <TableHead className="min-w-[320px]">Definition</TableHead>
              <TableHead className="w-[90px] text-right">Count</TableHead>
              <TableHead className="w-[120px]">Last seen</TableHead>
              <TableHead className="w-[110px]">8 weeks</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaries.map((item) => (
              <TableRow key={item.reason}>
                <TableCell className="font-mono text-xs font-medium">
                  {item.reason}
                  {item.reason === "fork-head" && (
                    <span className="ml-1 text-xs text-[var(--warning)]">*</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <div>{item.definition}</div>
                  {item.footnote && (
                    <div
                      className="mt-1 flex items-start gap-1 rounded bg-muted/40 p-1.5 text-[11px] text-foreground/80 leading-normal"
                      data-testid="fork-head-footnote"
                    >
                      <Info className="size-3 mt-0.5 shrink-0 text-muted-foreground" />
                      <span>
                        <strong>* Footnote:</strong> {item.footnote}
                      </span>
                    </div>
                  )}
                </TableCell>
                <TableCell className="tabular text-right font-medium">
                  {formatCount(item.count)}
                </TableCell>
                <TableCell className="tabular text-xs whitespace-nowrap">
                  {item.lastSeen ? (
                    formatTimestamp(item.lastSeen)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Sparkline
                    path={item.sparkline.path}
                    color={item.count > 0 ? "#DB4A78" : "#5A6377"}
                  />
                </TableCell>
                <TableCell>
                  <Link
                    to="/rounds"
                    search={{
                      range: linkableRange(range),
                      ...(repository ? { repository } : {}),
                    }}
                    className="text-xs text-primary underline-offset-4 hover:underline"
                  >
                    rounds ↗
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
          * A skipped run records a lane event rather than a full usage record. A zero count on
          fork-head reflects ingest authentication limits, not proof that no forks were submitted.
        </p>
      </CardContent>
    </Card>
  );
}
