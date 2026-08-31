import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink } from "lucide-react";

import { MAX_LIMIT_WITH_BLOBS } from "@/api/client";
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
import type { RangeKey } from "@/honesty/range";
import { formatCount, formatTimestamp } from "@/lib/format";
import {
  getFieldDegradedState,
  LANE_TOO_OLD_COPY,
  summariseConfigs,
} from "./failures";

export interface ConfigSectionProps {
  blobRows: RoundRow[];
  range: RangeKey;
  repository?: string;
}

function outcomeBadge(outcome: string) {
  switch (outcome) {
    case "ok":
      return (
        <Badge variant="outline" className="border-emerald-600 text-emerald-500 font-semibold">
          valid (ok)
        </Badge>
      );
    case "absent":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          absent
        </Badge>
      );
    case "unparseable":
    case "schema-rejected":
      return (
        <Badge variant="destructive" className="font-semibold">
          malformed ({outcome})
        </Badge>
      );
    default:
      return <Badge variant="outline">{outcome}</Badge>;
  }
}

export function ConfigSection({ blobRows, range, repository }: ConfigSectionProps) {
  const degraded = useMemo(
    () => getFieldDegradedState(blobRows, "config_resolution"),
    [blobRows],
  );
  const { items, scannedCount } = useMemo(() => summariseConfigs(blobRows), [blobRows]);
  const displayItems = useMemo(
    () => (repository ? items.filter((it) => it.repository === repository) : items),
    [items, repository],
  );

  return (
    <Card data-testid="section-configs">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <div>
          <CardTitle>3. Config parse outcomes</CardTitle>
          <p className="text-xs text-muted-foreground">
            Per-repository, per-layer configuration resolution and parse outcomes.
          </p>
        </div>
        <span className="tabular text-xs text-muted-foreground">
          n = {formatCount(scannedCount)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-0">
        {degraded === "lane-too-old" && (
          <div className="p-4 pb-0">
            <Degraded
              what="Config parse outcomes"
              reason="lane-did-not-send"
              detail={LANE_TOO_OLD_COPY}
            />
          </div>
        )}
        {degraded === "not-recorded" && (
          <div className="p-4 pb-0">
            <Degraded what="Config parse outcomes" reason="lane-sent-nothing" />
          </div>
        )}

        {displayItems.length === 0 && degraded === "recorded" ? (
          <p className="p-4 text-xs text-muted-foreground">
            No configuration resolution records found in the loaded window.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]">Repository</TableHead>
                <TableHead className="w-[140px]">Layer</TableHead>
                <TableHead className="min-w-[280px]">Definition</TableHead>
                <TableHead className="w-[160px]">Parse outcome</TableHead>
                <TableHead className="w-[120px]">Last evaluated</TableHead>
                <TableHead className="w-[140px]">Warning log</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayItems.map((item) => {
                const isMalformed =
                  item.outcome === "unparseable" || item.outcome === "schema-rejected";

                return (
                  <TableRow
                    key={`${item.repository}-${item.layer}`}
                    className={isMalformed ? "bg-destructive/10" : undefined}
                  >
                    <TableCell className="font-mono text-xs font-medium">
                      <Link
                        to="/rounds"
                        search={{ range, repository: item.repository }}
                        className="underline-offset-4 hover:underline"
                      >
                        {item.repository}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{item.layerTitle}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.definition}
                      {item.unconsumed.length > 0 && (
                        <span className="block mt-0.5 text-[11px] text-[var(--warning)]">
                          Unconsumed keys: {item.unconsumed.join(", ")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {degraded === "lane-too-old" ? (
                        <span className="text-xs text-muted-foreground">lane predates field</span>
                      ) : degraded === "not-recorded" ? (
                        <span className="text-xs text-muted-foreground">not recorded</span>
                      ) : (
                        outcomeBadge(item.outcome)
                      )}
                    </TableCell>
                    <TableCell className="tabular text-xs whitespace-nowrap">
                      {degraded === "recorded" && item.lastSeen ? (
                        formatTimestamp(item.lastSeen)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {item.warningRound?.run_url ? (
                        <a
                          href={item.warningRound.run_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[var(--warning)] underline-offset-4 hover:underline font-medium"
                        >
                          <AlertTriangle className="size-3.5" /> view warning{" "}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : item.warningRound ? (
                        <Link
                          to="/rounds/$sessionId"
                          params={{ sessionId: item.warningRound.session_id }}
                          search={{ at: item.warningRound.recorded_at }}
                          className="text-[var(--warning)] underline-offset-4 hover:underline font-medium"
                        >
                          warning round ↗
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <div className="flex flex-col gap-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <p>
            Computed over the most recent {scannedCount} rounds (capped at {MAX_LIMIT_WITH_BLOBS}{" "}
            rounds for blob payload budget).
          </p>
          <p>
            A malformed layer drops whole and applies workflow defaults; the lane does not fail.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
