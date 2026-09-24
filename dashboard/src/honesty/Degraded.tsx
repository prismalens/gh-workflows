import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * A missing field is a permanent, labelled state, not a spinner and not a
 * placeholder for a backend arriving later. The reason is part of the state
 * because an unbuilt column, a lane too old to send the field, and a lane that
 * could have sent it and did not are different facts and lead to different
 * actions (#46).
 */
export type DegradedReason =
  | "unbuilt"
  | "lane-did-not-send"
  | "lane-sent-nothing"
  | "unreadable"
  | "unobservable";

export const REASON_COPY: Record<
  DegradedReason,
  {
    badge: string;
    explain: string;
    /** The part of `explain` that says why the field is empty; a caller's `cause` replaces it. */
    cause?: string;
  }
> = {
  unbuilt: {
    badge: "not collected yet",
    explain:
      "No column holds this. It arrives when the issue that adds it lands, not when more rounds accumulate.",
  },
  "lane-did-not-send": {
    badge: "not sent by this lane",
    explain:
      "The store has the column and this round left it empty. The review lane that produced it predates the field, so this round will never carry it. Newer rounds from an upgraded lane will.",
    cause:
      "The review lane that produced it predates the field, so this round will never carry it. Newer rounds from an upgraded lane will.",
  },
  "lane-sent-nothing": {
    badge: "not recorded for this round",
    explain:
      "The store has the column and this round left it empty. The lane that recorded it was new enough to send the field and did not, so the gap is a fact about this round rather than about the lane version.",
  },
  unreadable: {
    badge: "not readable",
    explain:
      "The store holds a value for this round, but nothing in it can be counted. That is a fact about this payload, not about the lane version.",
  },
  unobservable: {
    badge: "not observable",
    explain:
      "The counterfactual this would need is never measured, so no honest number exists to show.",
  },
};

export interface DegradedProps {
  what: string;
  reason: DegradedReason;
  /** Where the field comes from, e.g. "issue 02 (verdict decoding)". */
  detail?: string;
  /**
   * What is known about why the field is empty. It replaces the reason's own `cause` sentence
   * when it has one (a runner round is not an old lane, #179), and is appended otherwise.
   */
  cause?: string;
  className?: string;
}

export function Degraded({ what, reason, detail, cause, className }: DegradedProps) {
  const copy = REASON_COPY[reason];
  const explain = cause && copy.cause ? copy.explain.replace(copy.cause, cause) : copy.explain;
  const extra = [cause && !copy.cause ? cause : null, detail].filter(Boolean).join(" ");
  return (
    <div
      className={cn("rounded-md border border-dashed border-border bg-muted/30 p-3", className)}
      data-testid="degraded"
      data-reason={reason}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{what}</span>
        <Badge variant="outline">{copy.badge}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {explain}
        {extra ? ` ${extra}` : ""}
      </p>
    </div>
  );
}

/**
 * For a figure that is real but derived from something the store only holds
 * partially, such as the per-model split standing in for per-agent fan-out.
 */
export function Approximate({ why }: { why: string }) {
  return (
    <Badge variant="outline" title={why} data-testid="approximate">
      approximate
    </Badge>
  );
}
