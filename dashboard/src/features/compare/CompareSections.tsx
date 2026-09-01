import type { ChangeRow } from "@/api/types";
import { Timestamp } from "@/components/Timestamp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RoundsTable } from "@/features/rounds/RoundsTable";
import { formatCount, formatDuration, formatMultiplier, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MetricComparison, RoundTypeComparisonResult } from "./compare";

export function EmptyChangesView() {
  return (
    <div className="flex flex-col gap-6" data-testid="empty-changes-view">
      <Alert variant="muted">
        <AlertTitle>No changes registered, therefore nothing to compare</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            The product allows exactly one efficiency claim: a measured before-and-after across a
            named change. Register a change row in the registry to compare review rounds before and
            after it.
          </p>
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold">Register a change via curl</h2>
          <p className="text-xs text-muted-foreground">
            Writing a change row requires a Cloudflare Access Service Token configured on the
            application. Changes anchor before-and-after windows by their landed timestamp (<code className="text-xs">at</code>).
          </p>
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs font-mono text-foreground">
{`curl -X POST https://review-telemetry.sfun.cloud/api/changes \\
  -H "Content-Type: application/json" \\
  -H "CF-Access-Client-Id: <SERVICE_TOKEN_CLIENT_ID>" \\
  -H "CF-Access-Client-Secret: <SERVICE_TOKEN_CLIENT_SECRET>" \\
  -d '{
    "name": "Upgrade reviewer to Claude 3.7 Sonnet",
    "at": "2026-08-31T12:00:00Z",
    "scope": "repo",
    "repository": "prismalens/gh-workflows",
    "source_url": "https://github.com/prismalens/gh-workflows/pull/73"
  }'`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

export function ChangeSelector({
  changes,
  selectedChange,
  onSelectChange,
}: {
  changes: ChangeRow[];
  selectedChange: ChangeRow;
  onSelectChange: (change: ChangeRow) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4" data-testid="change-selector">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-muted-foreground">Comparison anchor</span>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{selectedChange.name}</h1>
            <Badge variant="outline">{selectedChange.scope === "repo" ? selectedChange.repository ?? "repo" : "fleet"}</Badge>
            {selectedChange.source_url && (
              <a
                href={selectedChange.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary underline underline-offset-2 hover:text-foreground"
              >
                Source PR/Release ↗
              </a>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Landed at <Timestamp className="font-mono text-foreground" iso={selectedChange.at} /> (recorded{" "}
            <Timestamp iso={selectedChange.created_at} />)
          </p>
        </div>
      </div>

      {changes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border">
          <span className="text-xs text-muted-foreground mr-1">Select change:</span>
          {changes.map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant={c.id === selectedChange.id ? "secondary" : "ghost"}
              aria-pressed={c.id === selectedChange.id}
              onClick={() => onSelectChange(c)}
              className="text-xs"
            >
              {c.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WindowSummaryStrip({
  beforeCount,
  afterCount,
  change,
}: {
  beforeCount: number;
  afterCount: number;
  change: ChangeRow;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="window-summary-strip">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Before change window</span>
            <span className="tabular text-xs font-semibold text-muted-foreground" data-testid="before-window-n">
              n = {formatCount(beforeCount)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Rounds recorded strictly before{" "}
            <Timestamp className="font-mono text-foreground" iso={change.at} />
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">After change window</span>
            <span className="tabular text-xs font-semibold text-muted-foreground" data-testid="after-window-n">
              n = {formatCount(afterCount)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Rounds recorded at or after{" "}
            <Timestamp className="font-mono text-foreground" iso={change.at} />
          </p>
        </Card>
      </div>

      {beforeCount === 0 && (
        <Alert variant="muted" data-testid="empty-before-alert">
          <AlertTitle>No rounds recorded before this change</AlertTitle>
          <AlertDescription>
            No telemetry rounds exist before <Timestamp iso={change.at} />. Before-and-after deltas
            cannot be computed for an empty before window.
          </AlertDescription>
        </Alert>
      )}

      {afterCount === 0 && (
        <Alert variant="muted" data-testid="empty-after-alert">
          <AlertTitle>No rounds recorded after this change</AlertTitle>
          <AlertDescription>
            No telemetry rounds have been recorded at or after <Timestamp iso={change.at} />.
            Before-and-after deltas cannot be computed for an empty after window.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function MetricComparisonTile({
  label,
  comparison,
  format,
  deltaFormat,
  deltaSuffix = "",
}: {
  label: string;
  comparison: MetricComparison;
  format: (val: number) => string;
  deltaFormat?: (val: number) => string;
  deltaSuffix?: string;
}) {
  if (comparison.kind === "refused") {
    return (
      <Card className="min-w-0" data-testid={`metric-card-${label.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}>
        <CardContent className="flex flex-col gap-2 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <span className="tabular text-xs text-muted-foreground">
              before n={comparison.beforeN}, after n={comparison.afterN}
            </span>
          </div>
          <div className="rounded bg-muted/60 p-2.5">
            <p className="text-xs text-muted-foreground font-medium" data-testid="refusal-reason">
              {comparison.reason}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { beforeValue, afterValue, beforeN, afterN, deltaAbsolute, deltaPercent, deltaColor, lowN } =
    comparison;

  const fmtDelta = deltaFormat ? deltaFormat(deltaAbsolute) : format(deltaAbsolute);
  const sign = deltaAbsolute > 0 ? "+" : "";

  return (
    <Card className="min-w-0" data-testid={`metric-card-${label.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <div className="flex items-center gap-1.5">
            {lowN && (
              <Badge variant="warning" title="Deltas uncoloured when either side has n < 10" data-testid="low-n-badge">
                low n
              </Badge>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex flex-col">
            <span className="text-muted-foreground">Before (n = {beforeN})</span>
            <span className="tabular text-lg font-semibold">{format(beforeValue)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground">After (n = {afterN})</span>
            <span className="tabular text-lg font-semibold">{format(afterValue)}</span>
          </div>
        </div>

        <div className="flex items-baseline justify-between border-t border-border pt-2 text-xs">
          <span className="text-muted-foreground">Delta:</span>
          <span
            data-testid="metric-delta"
            className={cn(
              "tabular font-semibold",
              deltaColor === "improvement" && "text-emerald-600 dark:text-emerald-400",
              deltaColor === "regression" && "text-destructive dark:text-destructive",
              deltaColor === "neutral" && "text-foreground",
              deltaColor === "uncoloured" && "text-foreground font-normal",
            )}
          >
            {sign}{fmtDelta}{deltaSuffix}
            {deltaPercent !== null && ` (${sign}${deltaPercent.toFixed(1)}%)`}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function RoundTypeSection({
  result,
}: {
  result: RoundTypeComparisonResult;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4" data-testid={`round-type-section-${result.roundType}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">Round type: <span className="font-mono">{result.roundType}</span></h2>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>Before: <strong className="text-foreground">n = {result.beforeCount}</strong></span>
          <span>After: <strong className="text-foreground">n = {result.afterCount}</strong></span>
        </div>
      </div>

      {result.status !== "both" && (
        <Alert variant="muted" data-testid="round-type-single-side-alert">
          <AlertTitle>Round type not compared</AlertTitle>
          <AlertDescription>{result.explanation}</AlertDescription>
        </Alert>
      )}

      {result.status === "both" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {result.meanWallClock && (
            <MetricComparisonTile
              label="Mean wall clock"
              comparison={result.meanWallClock}
              format={formatDuration}
            />
          )}
          {result.p95WallClock && (
            <MetricComparisonTile
              label="p95 wall clock"
              comparison={result.p95WallClock}
              format={formatDuration}
            />
          )}
          {result.cacheHitRate && (
            <MetricComparisonTile
              label="Cache hit rate"
              comparison={result.cacheHitRate}
              format={formatPercent}
              deltaFormat={(d) => `${(d * 100).toFixed(1)} pt`}
            />
          )}
          {result.cachingMultiplier && (
            <MetricComparisonTile
              label="Caching multiplier"
              comparison={result.cachingMultiplier}
              format={formatMultiplier}
            />
          )}
          {result.denialsPerRound && (
            <MetricComparisonTile
              label="Denials per round"
              comparison={result.denialsPerRound}
              format={formatCount}
            />
          )}
        </div>
      )}

      {(result.beforeCount < 10 || result.afterCount < 10) && (
        <div className="mt-2 space-y-3">
          {result.beforeCount > 0 && result.beforeCount < 10 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Before rounds (n = {result.beforeCount}):</p>
              <RoundsTable rows={result.beforeRows} sorting={[]} onSortingChange={() => {}} />
            </div>
          )}
          {result.afterCount > 0 && result.afterCount < 10 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">After rounds (n = {result.afterCount}):</p>
              <RoundsTable rows={result.afterRows} sorting={[]} onSortingChange={() => {}} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
