import { useMemo } from "react";
import { Link } from "@tanstack/react-router";

import type { RoundRow } from "@/api/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Degraded } from "@/honesty/Degraded";
import type { RangeKey } from "@/honesty/range";
import { formatCount, formatTimestamp } from "@/lib/format";
import {
  getFieldDegradedState,
  LANE_TOO_OLD_COPY,
  summariseFallbacks,
} from "./failures";
import { Sparkline } from "./Sparkline";

export interface FallbacksSectionProps {
  rows: RoundRow[];
  now: Date;
  range: RangeKey;
  repository?: string;
}

export function FallbacksSection({ rows, now, range, repository }: FallbacksSectionProps) {
  const degraded = useMemo(() => getFieldDegradedState(rows, "fallback_reason"), [rows]);
  const summaries = useMemo(() => summariseFallbacks(rows, now), [rows, now]);

  return (
    <Card data-testid="section-fallbacks">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <div>
          <CardTitle>2. The six incremental fallbacks</CardTitle>
          <p className="text-xs text-muted-foreground">
            Fallback reasons emitted by the review lane (each forces a full review).
          </p>
        </div>
        <span className="tabular text-xs text-muted-foreground">
          n = {formatCount(rows.length)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-0">
        {degraded === "lane-too-old" && (
          <div className="p-4 pb-0">
            <Degraded
              what="Incremental fallbacks"
              reason="lane-did-not-send"
              detail={LANE_TOO_OLD_COPY}
            />
          </div>
        )}
        {degraded === "not-recorded" && (
          <div className="p-4 pb-0">
            <Degraded what="Incremental fallbacks" reason="lane-sent-nothing" />
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">Reason</TableHead>
              <TableHead className="min-w-[280px]">Definition</TableHead>
              <TableHead className="w-[90px] text-right">Count</TableHead>
              <TableHead className="w-[120px]">Last seen</TableHead>
              <TableHead className="w-[110px]">8 weeks</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaries.map((item) => (
              <TableRow key={item.key}>
                <TableCell className="font-mono text-xs font-medium">
                  {item.label}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{item.definition}</TableCell>
                <TableCell className="tabular text-right">
                  {degraded === "lane-too-old" ? (
                    <span className="text-xs text-muted-foreground">lane predates field</span>
                  ) : degraded === "not-recorded" ? (
                    <span className="text-xs text-muted-foreground">not recorded</span>
                  ) : (
                    formatCount(item.count)
                  )}
                </TableCell>
                <TableCell className="tabular text-xs whitespace-nowrap">
                  {degraded === "recorded" && item.lastSeen ? (
                    formatTimestamp(item.lastSeen)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Sparkline
                    path={item.sparkline.path}
                    color={degraded === "recorded" && item.count > 0 ? "#AD8734" : "#5A6377"}
                  />
                </TableCell>
                <TableCell>
                  <Link
                    to="/rounds"
                    search={{
                      range,
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
          An incremental fallback is not an error: it is a safe degradation to a full review when
          the baseline commit is missing, diverged, or too large.
        </p>
      </CardContent>
    </Card>
  );
}
