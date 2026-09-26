import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

import { parseConfigEffective } from "@/api/blobs";
import type { RoundRow } from "@/api/types";
import { Timestamp } from "@/components/Timestamp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { ConfigSection } from "@/features/failures/ConfigSection";
import type { RangeKey } from "@/honesty/range";

export const CONFIG_PATH = ".github/claude-review.yml";

// Narrowest last: a key from a narrower layer overrode every layer above it (#189).
const LAYER_ORDER = ["workflow", "org", "repo", "summon"] as const;

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function LayerChip({ layer }: { layer: string }) {
  const known = (LAYER_ORDER as readonly string[]).includes(layer);
  return (
    <Badge
      variant="outline"
      data-testid="layer-chip"
      className={layer === "workflow" ? "text-muted-foreground" : "font-semibold"}
      title={known ? `resolved at the ${layer} layer` : "a layer this dashboard does not know"}
    >
      {layer}
    </Badge>
  );
}

/** The newest round for this repository that carries config_effective. */
export function latestConfigRound(rows: readonly RoundRow[], repository: string): RoundRow | null {
  let latest: RoundRow | null = null;
  for (const row of rows) {
    if (row.repository !== repository || !row.config_effective) continue;
    if (!latest || row.recorded_at > latest.recorded_at) latest = row;
  }
  return latest;
}

export interface RepoConfigProps {
  repository: string;
  blobRows: RoundRow[];
  range: RangeKey;
}

/**
 * Read-only: what the lane resolved on this repository's newest round, and which layer supplied
 * each key. The dashboard is never a config layer; a change is a pull request against the
 * repository's own file, which the lane reads at the base ref (#189, #78).
 */
export function RepoConfig({ repository, blobRows, range }: RepoConfigProps) {
  const round = useMemo(() => latestConfigRound(blobRows, repository), [blobRows, repository]);
  const entries = useMemo(() => {
    const parsed = round ? parseConfigEffective(round) : null;
    return parsed ? Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b)) : [];
  }, [round]);
  const fileUrl = `https://github.com/${repository}/blob/HEAD/${CONFIG_PATH}`;

  return (
    <div className="flex flex-col gap-4">
      <Card data-testid="repo-config">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b border-border">
          <div>
            <CardTitle>Config in effect</CardTitle>
            <p className="text-xs text-muted-foreground">
              As the lane resolved it on the newest round that recorded it. Layers, widest first:{" "}
              {LAYER_ORDER.join(" → ")}.
            </p>
          </div>
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
          >
            Change it in {CONFIG_PATH} <ExternalLink className="size-3" />
          </a>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 p-0">
          {!round ? (
            <div className="p-4">
              <Alert variant="muted">
                <AlertTitle>No round in the loaded window recorded its config</AlertTitle>
                <AlertDescription>
                  Rounds carry config_effective since #75. Widen the range, or wait for the next
                  round on {repository}.
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <>
              <p className="px-4 pt-3 text-xs text-muted-foreground">
                From{" "}
                {round.pr_number != null ? (
                  <Link
                    to="/prs/$owner/$repo/$number"
                    params={{
                      owner: repository.split("/")[0],
                      repo: repository.split("/")[1],
                      number: String(round.pr_number),
                    }}
                    className="underline-offset-4 hover:underline"
                  >
                    PR #{round.pr_number}
                  </Link>
                ) : (
                  "a round"
                )}
                , <Timestamp iso={round.recorded_at} />. A change here goes through a pull request;
                the lane reads the file at each PR's base ref, never its head.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[220px]">Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead className="w-[120px]">Layer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map(([key, entry]) => (
                    <TableRow key={key} data-testid="config-row">
                      <TableCell className="font-mono text-xs">{key}</TableCell>
                      <TableCell className="font-mono text-xs break-all">
                        {formatValue(entry.value)}
                      </TableCell>
                      <TableCell>
                        <LayerChip layer={entry.layer} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>
      <ConfigSection blobRows={blobRows} range={range} repository={repository} />
    </div>
  );
}
