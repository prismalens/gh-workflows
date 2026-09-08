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

/** "rounds" -> "round", "findings" -> "finding". Every caller's unit is a plain plural noun. */
function singularOf(unit: string): string {
  return unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

export interface TileStripProps {
  n: number;
  /** What the window covers, e.g. "the last 7 days". */
  windowLabel: string;
  children: ReactNode;
  /**
   * What n counts, plural. Defaults to "rounds" - review-round telemetry, the only thing
   * this component originally measured. A caller counting something else (findings, pull
   * requests, ...) must say so, because "round" is otherwise asserted as a fact about rows
   * that were never rounds (#75 path_instructions: a label must be backed by what it names).
   */
  unit?: string;
  /**
   * The empty-state's second sentence. Defaults to the rounds-specific "not a run that cost
   * nothing", which only makes a claim rounds can support. A caller with a different unit
   * must supply its own, naming what an empty result there does and does not mean.
   */
  emptyExplanation?: string;
}

const DEFAULT_UNIT = "rounds";
const DEFAULT_EMPTY_EXPLANATION = "This is an absence of rounds, not a run that cost nothing.";

/**
 * Wraps every tile grid. It is what stops a thin range from being rendered as
 * aggregates, so tiles must not be placed on a page without it.
 */
export function TileStrip({
  n,
  windowLabel,
  children,
  unit = DEFAULT_UNIT,
  emptyExplanation = DEFAULT_EMPTY_EXPLANATION,
}: TileStripProps) {
  const mode = aggregateMode(n);
  const singular = singularOf(unit);

  if (mode === "empty") {
    return (
      <Alert variant="muted">
        <AlertTitle>No {unit} in range</AlertTitle>
        <AlertDescription>
          Nothing was recorded over {windowLabel}. {emptyExplanation}
        </AlertDescription>
      </Alert>
    );
  }

  if (mode === "table-instead") {
    return (
      <Alert variant="muted">
        <AlertTitle>
          {n} {n === 1 ? singular : unit} over {windowLabel}: the table below is the summary
        </AlertTitle>
        <AlertDescription>
          Aggregate tiles are withheld under {TILES_MIN_ROUNDS} {unit}. An aggregate metric over
          this many {unit} moves with any single {singular}, and the rows are short enough to
          read directly.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Over {windowLabel}, {n} {unit}.
      </p>
      <div
        data-testid="tile-strip"
        className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3"
      >
        {children}
      </div>
    </div>
  );
}
