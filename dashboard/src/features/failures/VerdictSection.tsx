import { useMemo } from "react";
import { Link } from "@tanstack/react-router";

import type { RoundRow } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Timestamp } from "@/components/Timestamp";
import { Degraded } from "@/honesty/Degraded";
import { linkableRange, type RangeKey } from "@/honesty/range";
import type { FourStateVerdict } from "@/honesty/verdict";
import { formatCount } from "@/lib/format";
import {
  getFieldDegradedState,
  LANE_TOO_OLD_COPY,
  summariseVerdicts,
} from "./failures";
import { Sparkline } from "./Sparkline";

export interface VerdictSectionProps {
  rows: RoundRow[];
  now: Date;
  range: RangeKey;
  repository?: string;
}

function groupBadgeVariant(group: FourStateVerdict) {
  switch (group) {
    case "reviewed":
      return { variant: "outline" as const, className: "border-emerald-600 text-emerald-500" };
    case "threads-only":
      return { variant: "outline" as const, className: "border-blue-600 text-blue-400" };
    case "did-not-run":
      return { variant: "warning" as const, className: "" };
    case "silent":
      return { variant: "destructive" as const, className: "" };
  }
}

function groupColor(group: FourStateVerdict) {
  switch (group) {
    case "reviewed":
      return "#3AA368";
    case "threads-only":
      return "#4E7FE0";
    case "did-not-run":
      return "#AD8734";
    case "silent":
      return "#DB4A78";
  }
}

export function VerdictSection({ rows, now, range, repository }: VerdictSectionProps) {
  const degraded = useMemo(() => getFieldDegradedState(rows, "verdict_kind"), [rows]);
  const summaries = useMemo(() => summariseVerdicts(rows, now), [rows, now]);

  return (
    <Card data-testid="section-verdicts">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <div>
          <CardTitle>1. Liveness verdicts</CardTitle>
          <p className="text-xs text-muted-foreground">
            All eight verdict kinds, grouped under the four-state decode.
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
              what="Liveness verdicts"
              reason="lane-did-not-send"
              detail={LANE_TOO_OLD_COPY}
            />
          </div>
        )}
        {degraded === "not-recorded" && (
          <div className="p-4 pb-0">
            <Degraded what="Liveness verdicts" reason="lane-sent-nothing" />
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">State</TableHead>
              <TableHead>Verdict kind</TableHead>
              <TableHead className="min-w-[280px]">Definition</TableHead>
              <TableHead className="w-[90px] text-right">Count</TableHead>
              <TableHead className="w-[120px]">Last seen</TableHead>
              <TableHead className="w-[110px]">8 weeks</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaries.map((item) => {
              const badge = groupBadgeVariant(item.group);
              const color = groupColor(item.group);

              return (
                <TableRow key={item.kind}>
                  <TableCell>
                    <Badge variant={badge.variant} className={badge.className}>
                      {item.group}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs font-medium">{item.kind}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.definition}
                  </TableCell>
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
                      <Timestamp iso={item.lastSeen} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Sparkline
                      path={item.sparkline.path}
                      color={degraded === "recorded" && item.count > 0 ? color : "#5A6377"}
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
              );
            })}
          </TableBody>
        </Table>
        <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
          Only reviewed rounds mean the head was read. Silent indicates the lane finished and posted
          nothing, so the head has no machine review on record.
        </p>
      </CardContent>
    </Card>
  );
}
