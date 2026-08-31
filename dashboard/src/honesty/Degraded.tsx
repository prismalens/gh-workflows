import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * A missing field is a permanent, labelled state, not a spinner and not a
 * placeholder for a backend arriving later. The reason is part of the state
 * because "the feature is unbuilt" and "this lane is older than the Worker" are
 * different facts and lead to different actions (#46).
 */
export type DegradedReason = "unbuilt" | "lane-did-not-send" | "unobservable";

const REASON_COPY: Record<DegradedReason, { badge: string; explain: string }> = {
  unbuilt: {
    badge: "not collected yet",
    explain:
      "No column holds this. It arrives when the issue that adds it lands, not when more rounds accumulate.",
  },
  "lane-did-not-send": {
    badge: "not sent by this lane",
    explain:
      "The store has the column and this round left it empty. The review lane that produced it predates the field, so this round will never carry it. Newer rounds from an upgraded lane will.",
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
  className?: string;
}

export function Degraded({ what, reason, detail, className }: DegradedProps) {
  const copy = REASON_COPY[reason];
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
        {copy.explain}
        {detail ? ` ${detail}` : ""}
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
