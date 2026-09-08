import { Badge } from "@/components/ui/badge";
import { shortSha } from "@/lib/format";
import { FATE_COPY, type FindingFate, type FixCitation } from "./findings";

/**
 * Colour per fate. `self-graded` is grey on purpose and must never become the
 * green used for `resolved-by-human` (#111): green here would present the lane
 * agreeing with itself as an independent result.
 */
function fateStyles(fate: FindingFate) {
  switch (fate) {
    case "never-answered":
      return {
        bg: "bg-[#AD87341f]",
        border: "border-[#AD873455]",
        text: "text-[var(--warning,#AD8734)]",
      };
    case "pushback-open":
      return {
        bg: "bg-[#4E7FE01f]",
        border: "border-[#4E7FE055]",
        text: "text-[#4E7FE0]",
      };
    case "resolved-by-human":
      return {
        bg: "bg-[#3AA3681f]",
        border: "border-[#3AA36855]",
        text: "text-[#3AA368]",
      };
    case "self-graded":
      return {
        bg: "bg-muted/40",
        border: "border-border",
        text: "text-muted-foreground",
      };
  }
}

export function FateChip({ fate }: { fate: FindingFate }) {
  const styles = fateStyles(fate);
  const copy = FATE_COPY[fate];
  return (
    <span
      data-testid="fate-chip"
      data-fate={fate}
      title={copy.explain}
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium border ${styles.bg} ${styles.border} ${styles.text}`}
    >
      {copy.label}
    </span>
  );
}

/** A fix_sha citation is its own badge, independent of and alongside a fate chip. */
export function FixCitedBadge({ citation }: { citation: FixCitation }) {
  return (
    <Badge
      variant="outline"
      title={`fix cited from ${citation.source}`}
      data-testid="fix-cited-badge"
      className="font-mono"
    >
      fix-cited {shortSha(citation.sha)}
    </Badge>
  );
}
