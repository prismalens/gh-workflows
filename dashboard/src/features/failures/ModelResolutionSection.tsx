import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";

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
import { Degraded } from "@/honesty/Degraded";
import { linkableRange, type RangeKey } from "@/honesty/range";
import { formatCount, formatTimestamp } from "@/lib/format";
import {
  getFieldDegradedState,
  LANE_TOO_OLD_COPY,
  summariseModelResolutions,
} from "./failures";
import { Sparkline } from "./Sparkline";

export interface ModelResolutionSectionProps {
  rows: RoundRow[];
  blobRows: RoundRow[];
  now: Date;
  range: RangeKey;
  repository?: string;
}

export function ModelResolutionSection({
  rows,
  blobRows,
  now,
  range,
  repository,
}: ModelResolutionSectionProps) {
  const degraded = useMemo(() => getFieldDegradedState(rows, "model_source"), [rows]);
  const { reasons, totalDenials, denialTools } = useMemo(
    () => summariseModelResolutions(rows, blobRows, now),
    [rows, blobRows, now],
  );

  return (
    <Card data-testid="section-model-resolution">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <div>
          <CardTitle>4. Model resolution reasons</CardTitle>
          <p className="text-xs text-muted-foreground">
            How the review model was chosen for each round, and permission denials by tool.
          </p>
        </div>
        <span className="tabular text-xs text-muted-foreground">
          n = {formatCount(rows.length)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-0">
        {degraded === "lane-too-old" && (
          <div className="p-4 pb-0">
            <Degraded
              what="Model resolution reasons"
              reason="lane-did-not-send"
              detail={LANE_TOO_OLD_COPY}
            />
          </div>
        )}
        {degraded === "not-recorded" && (
          <div className="p-4 pb-0">
            <Degraded what="Model resolution reasons" reason="lane-sent-nothing" />
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[260px]">Reason</TableHead>
              <TableHead className="min-w-[280px]">Definition</TableHead>
              <TableHead className="w-[90px] text-right">Count</TableHead>
              <TableHead className="w-[120px]">Last seen</TableHead>
              <TableHead className="w-[110px]">8 weeks</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {reasons.map((item) => {
              return (
                <TableRow
                  key={item.key}
                  className={
                    item.isSilentQualityDrop
                      ? "bg-[var(--warning)]/10 hover:bg-[var(--warning)]/15"
                      : undefined
                  }
                >
                  <TableCell className="font-mono text-xs font-medium">
                    <div className="flex flex-col gap-1">
                      <span
                        className={
                          item.isSilentQualityDrop
                            ? "font-semibold text-[var(--warning)]"
                            : undefined
                        }
                      >
                        {item.key}
                      </span>
                      {item.isSilentQualityDrop && (
                        <Badge
                          variant="warning"
                          className="w-fit text-[10px] uppercase tracking-wider"
                        >
                          silent quality drop
                        </Badge>
                      )}
                    </div>
                  </TableCell>
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
                      formatTimestamp(item.lastSeen)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Sparkline
                      path={item.sparkline.path}
                      color={
                        item.isSilentQualityDrop
                          ? "#AD8734"
                          : degraded === "recorded" && item.count > 0
                            ? "#3AA368"
                            : "#5A6377"
                      }
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

        {/* Denial-tools histogram section */}
        <div className="border-t border-border px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Permission denials by tool
            </h4>
            <span className="tabular text-xs text-muted-foreground">
              Total denials in range: {formatCount(totalDenials)}
            </span>
          </div>

          {denialTools === null ? (
            <div className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 mb-1 font-medium text-foreground">
                <AlertCircle className="size-3.5 text-muted-foreground" />
                <span>Per-tool breakdown is not loaded</span>
              </div>
              <p>
                Total permission denials: {formatCount(totalDenials)}. The tool-by-tool breakdown
                lives inside <code className="text-xs font-mono">raw_result.denial_tools</code> and
                is not reachable within this page's row budget without a dedicated route.
              </p>
            </div>
          ) : denialTools.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No permission denials recorded in the loaded blob rounds.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Tool</TableHead>
                  <TableHead className="w-[120px] text-right">Denials count</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {denialTools.map((entry) => (
                  <TableRow key={entry.tool}>
                    <TableCell className="font-mono text-xs font-medium">{entry.tool}</TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {formatCount(entry.count)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
