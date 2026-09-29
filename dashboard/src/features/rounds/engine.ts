import type { RoundRow } from "@/api/types";

/** Only the runner path writes `engine` (#184), so a null one is an Actions-lane round (#185). */
export const ACTIONS_LANE = "Actions lane";
/** A row with no `engine` field at all came from a Worker that predates it. */
export const ENGINE_NOT_RECORDED = "engine not recorded";

export function engineLabel(row: Pick<RoundRow, "engine">): string {
  if (row.engine === undefined) return ENGINE_NOT_RECORDED;
  return row.engine || ACTIONS_LANE;
}

export function distinctEngines(rows: Pick<RoundRow, "engine">[]): string[] {
  return [...new Set(rows.map(engineLabel))].sort();
}
