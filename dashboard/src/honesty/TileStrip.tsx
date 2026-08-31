import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TILES_MIN_ROUNDS } from "./thresholds";

export type AggregateMode = "empty" | "table-instead" | "tiles";

/**
 * Below TILES_MIN_ROUNDS the row list is the honest view and it is short enough
 * to read, so aggregates are not offered at all (#46).
 */
export function aggregateMode(n: number): AggregateMode {
  if (n === 0) return "empty";
  if (n < TILES_MIN_ROUNDS) return "table-instead";
  return "tiles";
}

export interface TileStripProps {
  n: number;
  /** What the window covers, e.g. "the last 7 days". */
  windowLabel: string;
  children: ReactNode;
}

/**
 * Wraps every tile grid. It is what stops a thin range from being rendered as
 * aggregates, so tiles must not be placed on a page without it.
 */
export function TileStrip({ n, windowLabel, children }: TileStripProps) {
  const mode = aggregateMode(n);

  if (mode === "empty") {
    return (
      <Alert variant="muted">
        <AlertTitle>No rounds in range</AlertTitle>
        <AlertDescription>
          Nothing was recorded over {windowLabel}. This is an absence of rounds, not a run that
          cost nothing.
        </AlertDescription>
      </Alert>
    );
  }

  if (mode === "table-instead") {
    return (
      <Alert variant="muted">
        <AlertTitle>
          {n} {n === 1 ? "round" : "rounds"} over {windowLabel}: the table below is the summary
        </AlertTitle>
        <AlertDescription>
          Aggregate tiles are withheld under {TILES_MIN_ROUNDS} rounds. A mean over this many
          rounds moves with any single round, and the rows are short enough to read directly.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Over {windowLabel}, {n} rounds.
      </p>
      <div
        data-testid="tile-strip"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {children}
      </div>
    </div>
  );
}
