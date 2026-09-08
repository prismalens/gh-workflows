import { Card, CardContent } from "@/components/ui/card";
import { Approximate } from "@/honesty/Degraded";
import {
  VERDICT_KIND_BUCKET_COPY,
  type VerdictKindBucket,
  type VerdictKindMix,
} from "@/honesty/verdict";
import { formatCount, formatPercent } from "@/lib/format";

const SEGMENTS: ReadonlyArray<{
  bucket: VerdictKindBucket;
  mixKey: keyof Omit<VerdictKindMix, "n">;
  color: string;
}> = [
  { bucket: "reviewed", mixKey: "reviewed", color: "var(--chart-1)" },
  { bucket: "threads-only", mixKey: "threadsOnly", color: "var(--chart-3)" },
  { bucket: "did-not-run", mixKey: "didNotRun", color: "var(--chart-2)" },
  { bucket: "silent", mixKey: "silent", color: "var(--chart-4)" },
  { bucket: "error", mixKey: "error", color: "var(--destructive)" },
  { bucket: "unread", mixKey: "unread", color: "var(--chart-5)" },
  { bucket: "no-verdict-recorded", mixKey: "noVerdictRecorded", color: "var(--muted-foreground)" },
];

export interface VerdictStripProps {
  mix: VerdictKindMix;
  windowLabel: string;
}

/**
 * Sits directly under the activity band because it is what makes the bold counts
 * above it trustworthy: it says how many of those rounds are ones we can claim
 * read a head. Bucketed straight from verdict_kind (#141); a round with no
 * verdict_kind is its own bucket rather than a guess from round_type.
 */
export function VerdictStrip({ mix, windowLabel }: VerdictStripProps) {
  return (
    <Card className="min-w-0">
      <CardContent className="flex flex-col gap-2 p-4" data-testid="verdict-strip">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Verdict mix</span>
          <span className="flex items-center gap-2">
            <Approximate why="Seven buckets decoded from verdict_kind. A round recorded before that field existed falls into no verdict recorded rather than being guessed at." />
            <span className="tabular text-xs text-muted-foreground">n = {formatCount(mix.n)}</span>
          </span>
        </div>

        {mix.n === 0 ? (
          <span className="text-sm text-muted-foreground">no rounds in range</span>
        ) : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded-sm">
              {SEGMENTS.map((segment) => (
                <div
                  key={segment.bucket}
                  style={{
                    backgroundColor: segment.color,
                    width: `${(mix[segment.mixKey] / mix.n) * 100}%`,
                  }}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
              {SEGMENTS.map((segment) => (
                <span
                  key={segment.bucket}
                  className="inline-flex items-center gap-1.5 text-muted-foreground"
                  title={VERDICT_KIND_BUCKET_COPY[segment.bucket].explain}
                >
                  <span
                    aria-hidden
                    className="size-2.5 rounded-[2px]"
                    style={{ backgroundColor: segment.color }}
                  />
                  {VERDICT_KIND_BUCKET_COPY[segment.bucket].label}{" "}
                  <span className="tabular font-medium text-foreground">
                    {formatCount(mix[segment.mixKey])}
                  </span>
                  <span className="tabular">({formatPercent(mix[segment.mixKey] / mix.n)})</span>
                </span>
              ))}
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Over {windowLabel}. Reviewed, threads-only, did-not-run, silent, error and unread are
          decoded from verdict_kind. Unread means the round finished but the GitHub API would not
          confirm what it posted — not a failure, not silence. No verdict recorded means the round
          predates that field.
        </p>
      </CardContent>
    </Card>
  );
}
