import type { RoundRow } from "@/api/types";

/** Only the runner path writes `engine` (#184), so a null one is an Actions-lane round (#185). */
export const ACTIONS_LANE = "Actions lane";

export function engineLabel(row: Pick<RoundRow, "engine">): string {
  return row.engine || ACTIONS_LANE;
}

export function distinctEngines(rows: Pick<RoundRow, "engine">[]): string[] {
  return [...new Set(rows.map(engineLabel))].sort();
}
