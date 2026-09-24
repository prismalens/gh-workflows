import type { DegradedReason } from "./Degraded";

/**
 * #173 added failure_class, credential_type, context_*, base_pr_number, patch_fingerprint and
 * round_agents.tool_detail/harness_paths_count on 2026-09-14 and left LANE_VERSION at 4, so
 * lane 5 is the first version that always knows them (#179).
 */
export const FIELD_ERA_LANE_VERSION = 5;

export const LANE_4_STRADDLES =
  "Lane 4 straddles this field: added 2026-09-14 (#173) with no version bump.";

export const LANE_VERSION_UNKNOWN =
  "This round carries no lane version, so when its sender added this field is unknown.";

export const RUNNER_DOES_NOT_SEND = "A runner round (#196) does not send this field yet.";

/** "4", "v2.0.0" and "5.1" all read as their major; anything unparseable is null. */
export function laneMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const major = parseInt(version.replace(/^v/i, "").trim().split(".")[0], 10);
  return Number.isNaN(major) ? null : major;
}

export interface FieldEra {
  reason: Extract<DegradedReason, "lane-did-not-send" | "lane-sent-nothing">;
  /** Short enough for a fact cell. */
  label: string;
  detail: string;
}

/** #100's rule for a null #173 field: which fact the empty column states about this round. */
export function fieldEra(row: {
  lane_version: string | null;
  ingest_auth?: string | null;
}): FieldEra {
  // The Worker stamps runner rounds (#196), whose lane_version is null unless one is passed.
  if (row.ingest_auth === "runner") {
    return {
      reason: "lane-did-not-send",
      label: "not sent by the runner",
      detail: RUNNER_DOES_NOT_SEND,
    };
  }
  const major = laneMajor(row.lane_version);
  if (major !== null && major >= FIELD_ERA_LANE_VERSION) {
    return {
      reason: "lane-sent-nothing",
      label: "not recorded for this round",
      detail: `Lane ${major} always knows this field.`,
    };
  }
  return {
    reason: "lane-did-not-send",
    label: "not recorded by this lane version",
    detail:
      major === 4
        ? LANE_4_STRADDLES
        : major === null
          ? LANE_VERSION_UNKNOWN
          : `Lane ${major} predates this field, added 2026-09-14 (#173).`,
  };
}
