import { Link } from "@tanstack/react-router";

import { Timestamp } from "@/components/Timestamp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Degraded } from "@/honesty/Degraded";
import { formatDuration, orDash } from "@/lib/format";
import { ATTENTION_KIND_COPY, type AttentionCard, type AttentionKind } from "./attention";

const KIND_VARIANT: Record<AttentionKind, "destructive" | "warning" | "outline"> = {
  error: "destructive",
  denials: "warning",
  retry: "outline",
};

export interface AttentionFeedProps {
  cards: AttentionCard[];
  /** How many rounds the feed could read, which is not the whole window. */
  scanned: number;
  windowLabel: string;
}

/**
 * The feed reads a page of its own with include=blobs, because is_error and the
 * denied tool names live in raw_result and the list route only sends the blob
 * columns when asked. That route caps a blob page at 50 rounds, so the feed
 * covers the most recent 50 of the window and says so rather than implying it
 * has read everything above it.
 */
export function AttentionFeed({ cards, scanned, windowLabel }: AttentionFeedProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Needs attention</h2>
        <span className="text-xs text-muted-foreground">
          {cards.length === 0 ? "nothing" : `${cards.length} over ${windowLabel}`}, from the most
          recent {scanned} rounds
        </span>
      </div>

      {cards.length === 0 ? (
        <Alert variant="muted">
          <AlertTitle>No denials, retries or errors in the rounds read</AlertTitle>
          <AlertDescription>
            The {scanned} most recent rounds carry no permission denial, no run attempt above one
            and no reported error. Older rounds in this window were not read.
          </AlertDescription>
        </Alert>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Recorded</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>PR</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Wall clock</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cards.map((card) => (
              <TableRow key={`${card.row.session_id}-${card.kind}`}>
                <TableCell>
                  <Link
                    to="/rounds/$sessionId"
                    params={{ sessionId: card.row.session_id }}
                    search={{ at: card.row.recorded_at }}
                    className="tabular whitespace-nowrap underline-offset-4 hover:underline"
                  >
                    <Timestamp iso={card.row.recorded_at} />
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">{card.row.repository}</TableCell>
                <TableCell>
                  {card.row.pr_url && card.row.pr_number !== null ? (
                    <a
                      href={card.row.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      className="tabular underline-offset-4 hover:underline"
                    >
                      #{card.row.pr_number}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={KIND_VARIANT[card.kind]} title={ATTENTION_KIND_COPY[card.kind]}>
                    {card.reason}
                  </Badge>
                </TableCell>
                <TableCell className="tabular">
                  {orDash(card.row.duration_ms, formatDuration)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{card.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Degraded
        what="Silent rounds, fallback reasons, stale findings and malformed config"
        reason="unbuilt"
        detail="The artboard draws six card kinds. Three are derivable from recorded columns and are above; the other three need fields no column holds, and each arrives with its own issue (#46)."
      />
    </div>
  );
}
