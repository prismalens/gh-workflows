import type { LaneEventRow, RoundRow } from "@/api/types";
import {
  ALL_VERDICT_KINDS,
  type FourStateVerdict,
  type VerdictKind,
  VERDICT_KIND_DEFINITIONS,
} from "@/honesty/verdict";

export type Wave2DegradedState = "empty" | "lane-too-old" | "not-recorded" | "recorded";

export const LANE_TOO_OLD_COPY =
  "The recording lane predates the field, which an adopter fixes by updating their lane.";

export function isLaneVersionAtLeast2(version: string | null | undefined): boolean {
  if (!version) return false;
  const clean = version.replace(/^v/i, "").trim();
  const major = parseInt(clean.split(".")[0], 10);
  return !Number.isNaN(major) && major >= 2;
}

export function getFieldDegradedState(
  rows: RoundRow[],
  fieldAccessor: keyof RoundRow | ((row: RoundRow) => unknown),
): Wave2DegradedState {
  if (rows.length === 0) return "empty";

  const hasWave2Lanes = rows.some((row) => isLaneVersionAtLeast2(row.lane_version));
  if (!hasWave2Lanes) {
    return "lane-too-old";
  }

  const hasAnyRecorded = rows.some((row) => {
    const val = typeof fieldAccessor === "function" ? fieldAccessor(row) : row[fieldAccessor];
    return val !== null && val !== undefined && val !== "";
  });

  if (!hasAnyRecorded) {
    return "not-recorded";
  }

  return "recorded";
}

/**
 * 8-week sparkline computation.
 * Generates 8 weekly bucket counts from (now - 56 days) to now.
 */
export function buildSparkline(
  timestamps: string[],
  now: Date,
): { counts: number[]; path: string } {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const counts = new Array<number>(8).fill(0);

  for (const ts of timestamps) {
    const t = new Date(ts).getTime();
    if (Number.isNaN(t)) continue;
    const diff = nowMs - t;
    if (diff >= 0 && diff < 8 * WEEK_MS) {
      const bucketIndex = 7 - Math.floor(diff / WEEK_MS);
      if (bucketIndex >= 0 && bucketIndex < 8) {
        counts[bucketIndex]++;
      }
    }
  }

  const max = Math.max(...counts, 0);
  // SVG coordinates: width 96, height 20. X points: 6, 18, 30, 42, 54, 66, 78, 90
  const xPoints = [6, 18, 30, 42, 54, 66, 78, 90];
  const pathParts = counts.map((count, i) => {
    const x = xPoints[i];
    const y = max === 0 ? 18 : 18 - (count / max) * 14;
    return `${i === 0 ? "M" : "L"}${x},${Number(y.toFixed(1))}`;
  });

  return { counts, path: pathParts.join(" ") };
}

// ---------------- Section 1: Liveness verdicts ----------------

export interface VerdictRowSummary {
  kind: VerdictKind;
  group: FourStateVerdict;
  definition: string;
  count: number;
  lastSeen: string | null;
  sparkline: { counts: number[]; path: string };
  matchingRows: RoundRow[];
}

export function summariseVerdicts(rows: RoundRow[], now: Date): VerdictRowSummary[] {
  return ALL_VERDICT_KINDS.map((kind) => {
    const info = VERDICT_KIND_DEFINITIONS[kind];
    const matching = rows.filter((r) => r.verdict_kind === kind);
    const timestamps = matching.map((r) => r.recorded_at);
    const latest = matching.reduce<string | null>(
      (acc, r) => (acc === null || r.recorded_at > acc ? r.recorded_at : acc),
      null,
    );

    return {
      kind,
      group: info.group,
      definition: info.definition,
      count: matching.length,
      lastSeen: latest,
      sparkline: buildSparkline(timestamps, now),
      matchingRows: matching,
    };
  });
}

// ---------------- Section 2: Incremental fallbacks ----------------

export const FALLBACK_REASONS = [
  "no-baseline",
  "identical-summon",
  "baseline-gone",
  "diverged",
  "range-too-large",
  "unexpected-status-*",
] as const;

export type FallbackReasonKey = (typeof FALLBACK_REASONS)[number];

export const FALLBACK_DEFINITIONS: Record<FallbackReasonKey, string> = {
  "no-baseline": "First round on the PR; no prior liveness marker to diff against",
  "identical-summon": "Summon on an already-reviewed head identical to baseline",
  "baseline-gone": "Baseline commit not found (HTTP 404), e.g. after a force-push",
  diverged: "Compare status between baseline and head is diverged or behind",
  "range-too-large": "Compare range between baseline and head exceeds 300 files",
  "unexpected-status-*": "GitHub compare returned an unmodeled HTTP status",
};

export interface FallbackRowSummary {
  key: FallbackReasonKey;
  label: string;
  definition: string;
  count: number;
  lastSeen: string | null;
  sparkline: { counts: number[]; path: string };
  distinctStatuses: string[];
  matchingRows: RoundRow[];
}

export function summariseFallbacks(rows: RoundRow[], now: Date): FallbackRowSummary[] {
  return FALLBACK_REASONS.map((key) => {
    const definition = FALLBACK_DEFINITIONS[key];
    let matching: RoundRow[];
    let distinctStatuses: string[] = [];

    if (key === "unexpected-status-*") {
      matching = rows.filter((r) => r.fallback_reason?.startsWith("unexpected-status-"));
      const statuses = matching
        .map((r) => r.fallback_reason?.replace(/^unexpected-status-/, ""))
        .filter((s): s is string => !!s);
      distinctStatuses = [...new Set(statuses)].sort();
    } else {
      matching = rows.filter((r) => r.fallback_reason === key);
    }

    const timestamps = matching.map((r) => r.recorded_at);
    const latest = matching.reduce<string | null>(
      (acc, r) => (acc === null || r.recorded_at > acc ? r.recorded_at : acc),
      null,
    );

    const label =
      key === "unexpected-status-*" && distinctStatuses.length > 0
        ? `unexpected-status-* (${distinctStatuses.join(", ")})`
        : key;

    return {
      key,
      label,
      definition,
      count: matching.length,
      lastSeen: latest,
      sparkline: buildSparkline(timestamps, now),
      distinctStatuses,
      matchingRows: matching,
    };
  });
}

// ---------------- Section 3: Config parse outcomes ----------------

export interface ConfigLayerOutcome {
  repository: string;
  layer: string;
  layerTitle: string;
  definition: string;
  outcome: string;
  unconsumed: string[];
  lastSeen: string | null;
  warningRound: RoundRow | null;
}

export const CONFIG_LAYERS = [
  {
    layer: "repo_config",
    layerTitle: "Repo config",
    definition: "Repository review policy (.github/claude-review.yml at base ref)",
  },
  {
    layer: "org_defaults",
    layerTitle: "Org defaults",
    definition: "Organization default policy (.github/claude-review-defaults.yml)",
  },
  {
    layer: "workflow_inputs",
    layerTitle: "Workflow inputs",
    definition: "Workflow caller inputs and action defaults",
  },
] as const;

export function summariseConfigs(blobRows: RoundRow[]): {
  items: ConfigLayerOutcome[];
  scannedCount: number;
} {
  // Sort newest first
  const sorted = [...blobRows].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  const repos = [...new Set(sorted.map((r) => r.repository))].sort();
  const items: ConfigLayerOutcome[] = [];

  for (const repository of repos) {
    const repoRows = sorted.filter((r) => r.repository === repository);
    for (const layerDef of CONFIG_LAYERS) {
      let outcome = "absent";
      let unconsumed: string[] = [];
      let lastSeen: string | null = null;
      let warningRound: RoundRow | null = null;

      for (const round of repoRows) {
        if (!round.config_resolution) continue;
        try {
          const parsed =
            typeof round.config_resolution === "string"
              ? JSON.parse(round.config_resolution)
              : round.config_resolution;
          const layerData = parsed?.layers?.[layerDef.layer];
          if (layerData) {
            outcome = layerData.outcome || "absent";
            unconsumed = Array.isArray(layerData.unconsumed) ? layerData.unconsumed : [];
            lastSeen = round.recorded_at;
            if (outcome === "unparseable" || outcome === "schema-rejected") {
              warningRound = round;
            }
            break;
          }
        } catch {
          // malformed JSON string
        }
      }

      items.push({
        repository,
        layer: layerDef.layer,
        layerTitle: layerDef.layerTitle,
        definition: layerDef.definition,
        outcome,
        unconsumed,
        lastSeen,
        warningRound,
      });
    }
  }

  return { items, scannedCount: blobRows.length };
}

// ---------------- Section 4: Model resolution reasons & Denial tools ----------------

export const MODEL_SOURCES = [
  "default",
  "summon override",
  "escalated by path match",
  "default (changed-files fetch failed)",
] as const;

export type ModelSourceKey = (typeof MODEL_SOURCES)[number];

export const MODEL_SOURCE_DEFINITIONS: Record<ModelSourceKey, string> = {
  default: "Workflow default model used",
  "summon override": "Model explicitly overridden via summon argument",
  "escalated by path match": "Escalated to Opus because modified files matched path filter rules",
  "default (changed-files fetch failed)":
    "Silent quality drop: failed to fetch changed files to evaluate path escalation, so quietly fell back to default model",
};

export interface ModelResolutionRowSummary {
  key: ModelSourceKey;
  definition: string;
  count: number;
  lastSeen: string | null;
  sparkline: { counts: number[]; path: string };
  isSilentQualityDrop: boolean;
  matchingRows: RoundRow[];
}

export interface DenialToolCount {
  tool: string;
  count: number;
}

export function summariseModelResolutions(
  rows: RoundRow[],
  blobRows: RoundRow[],
  now: Date,
): {
  reasons: ModelResolutionRowSummary[];
  totalDenials: number;
  denialTools: DenialToolCount[] | null;
} {
  const reasons: ModelResolutionRowSummary[] = MODEL_SOURCES.map((key) => {
    const matching = rows.filter((r) => r.model_source === key);
    const timestamps = matching.map((r) => r.recorded_at);
    const latest = matching.reduce<string | null>(
      (acc, r) => (acc === null || r.recorded_at > acc ? r.recorded_at : acc),
      null,
    );

    return {
      key,
      definition: MODEL_SOURCE_DEFINITIONS[key],
      count: matching.length,
      lastSeen: latest,
      sparkline: buildSparkline(timestamps, now),
      isSilentQualityDrop: key === "default (changed-files fetch failed)",
      matchingRows: matching,
    };
  });

  const totalDenials = rows.reduce((sum, r) => sum + (r.permission_denials ?? 0), 0);

  // Denial tools per-tool histogram from blob rows
  let denialTools: DenialToolCount[] | null = null;
  const toolMap = new Map<string, number>();
  let hasDenialToolsData = false;

  for (const round of blobRows) {
    if (!round.raw_result) continue;
    try {
      const raw =
        typeof round.raw_result === "string" ? JSON.parse(round.raw_result) : round.raw_result;
      if (Array.isArray(raw?.denial_tools)) {
        hasDenialToolsData = true;
        for (const entry of raw.denial_tools) {
          if (entry && typeof entry.tool === "string" && typeof entry.count === "number") {
            toolMap.set(entry.tool, (toolMap.get(entry.tool) ?? 0) + entry.count);
          }
        }
      }
    } catch {
      // ignore JSON parse error
    }
  }

  if (hasDenialToolsData) {
    denialTools = Array.from(toolMap.entries())
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  }

  return { reasons, totalDenials, denialTools };
}

// ---------------- Section 5: Rounds that never happened ----------------

export const LANE_EVENT_REASONS = [
  "no-token",
  "auto-paused",
  "fork-head",
  "skip-author",
] as const;

export type LaneEventReasonKey = (typeof LANE_EVENT_REASONS)[number];

export const LANE_EVENT_DEFINITIONS: Record<LaneEventReasonKey, string> = {
  "no-token": "Run skipped because no CLAUDE_CODE_OAUTH_TOKEN secret was available",
  "auto-paused": "Run skipped because PR exceeded auto_pause_rounds limit",
  "fork-head":
    "Run skipped on fork head (summon only; automatic fork PRs cannot authenticate to post lane events)",
  "skip-author": "Run skipped because PR author matches skip_authors configuration",
};

export const FORK_HEAD_FOOTNOTE =
  "GitHub withholds secrets from a fork's pull_request run, so the ingest token is empty and an automatic fork pull request cannot post a lane event. The only reachable fork-head case is a summon on a fork head. So a zero here does not mean no forks were skipped.";

export interface LaneEventRowSummary {
  reason: LaneEventReasonKey;
  definition: string;
  count: number;
  lastSeen: string | null;
  sparkline: { counts: number[]; path: string };
  footnote?: string;
  matchingEvents: LaneEventRow[];
}

export function summariseLaneEvents(
  events: LaneEventRow[],
  now: Date,
): LaneEventRowSummary[] {
  return LANE_EVENT_REASONS.map((reason) => {
    const matching = events.filter((e) => e.reason === reason);
    const timestamps = matching.map((e) => e.recorded_at);
    const latest = matching.reduce<string | null>(
      (acc, e) => (acc === null || e.recorded_at > acc ? e.recorded_at : acc),
      null,
    );

    return {
      reason,
      definition: LANE_EVENT_DEFINITIONS[reason],
      count: matching.length,
      lastSeen: latest,
      sparkline: buildSparkline(timestamps, now),
      footnote: reason === "fork-head" ? FORK_HEAD_FOOTNOTE : undefined,
      matchingEvents: matching,
    };
  });
}
