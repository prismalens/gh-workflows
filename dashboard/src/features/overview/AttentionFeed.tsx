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
  "never-answered": "warning",
};

export interface AttentionFeedProps {
  cards: AttentionCard[];
  /** How many rounds the feed could read, which is not the whole window. */
  scanned: number;
  windowLabel: string;
  /**
   * How many findings the feed read, or null when the findings route did not
   * answer. Zero and null both read as "nothing is unanswered" if left unsaid,
   * so the feed names which of the three states it is in.
   */
  findingsRead: number | null;
}

/**
 * The feed reads a page of its own with include=blobs, because is_error and the
 * denied tool names live in raw_result and the list route only sends the blob
 * columns when asked. That route caps a blob page at 50 rounds, so the feed
 * covers the most recent 50 of the window and says so rather than implying it
 * has read everything above it.
 */
export function AttentionFeed({ cards, scanned, windowLabel, findingsRead }: AttentionFeedProps) {
  const roundCards = cards.filter((card) => card.source === "round");
  const findingCards = cards.filter((card) => card.source === "finding");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Needs attention</h2>
        <span className="text-xs text-muted-foreground">
          {roundCards.length === 0 ? "nothing" : `${roundCards.length} over ${windowLabel}`}, from
          the most recent {scanned} rounds
        </span>
        <span className="text-xs text-muted-foreground">
          {/* Findings carry no round, so the round range does not scope them and
              saying "over {windowLabel}" here would be false. */}
          {findingsRead === null
            ? "findings could not be read, so never-answered is unknown here"
            : findingsRead === 0
              ? "no finding has been swept, so never-answered is unknown rather than zero"
              : `${findingCards.length} never answered, of ${findingsRead} findings recorded; the round window does not scope these`}
        </span>
      </div>

      {cards.length === 0 ? (
        <Alert variant="muted">
          <AlertTitle>No denials, retries or errors in the rounds read</AlertTitle>
          <AlertDescription>
            The {scanned} most recent rounds carry no permission denial, no run attempt above one
            and no reported error. Older rounds in this window were not read.
            {findingsRead === null
              ? " Findings were not read at all, so nothing here speaks to them."
              : findingsRead === 0
                ? " No finding is recorded either, which means no sweep has written one, not that every finding was answered."
                : ` None of the ${findingsRead} findings recorded is unanswered.`}
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
            {cards.map((card) =>
              card.source === "round" ? (
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
              ) : (
                <TableRow key={card.finding.thread_node_id} data-testid="attention-finding-row">
                  <TableCell>
                    {card.finding.thread_created_at ? (
                      <span className="tabular whitespace-nowrap">
                        <Timestamp iso={card.finding.thread_created_at} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{card.finding.repository}</TableCell>
                  <TableCell>
                    <a
                      href={`https://github.com/${card.finding.repository}/pull/${card.finding.pr_number}/files`}
                      target="_blank"
                      rel="noreferrer"
                      className="tabular underline-offset-4 hover:underline"
                    >
                      #{card.finding.pr_number}
                    </a>
                  </TableCell>
                  <TableCell>
                    <Badge variant={KIND_VARIANT[card.kind]} title={ATTENTION_KIND_COPY[card.kind]}>
                      {card.reason}
                    </Badge>
                  </TableCell>
                  {/* A finding has no round, so it has no wall clock. */}
                  <TableCell className="text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <Link
                      to="/findings"
                      search={{ fate: "never-answered", repository: card.finding.repository }}
                      className="underline-offset-4 hover:underline"
                    >
                      {card.detail}
                    </Link>
                  </TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      )}

      <Degraded
        what="Silent rounds, fallback reasons and malformed config"
        reason="unbuilt"
        detail="These three card kinds the artboard draws need fields no column holds, and each arrives with its own issue (#46). Never-answered findings left this list when #111 landed review_findings, and are in the feed above."
      />
    </div>
  );
}
