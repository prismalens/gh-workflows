import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LaneEventRow, RoundRow } from "@/api/types";
import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { RANGE_KEYS } from "@/honesty/range";
import { renderRoute } from "@/test/renderRoute";
import {
  ALL_VERDICT_KINDS,
  decodeVerdict,
  VERDICT_KIND_DEFINITIONS,
  VERDICT_KIND_MAP,
} from "@/honesty/verdict";
import {
  FALLBACK_REASONS,
  FORK_HEAD_FOOTNOTE,
  getFieldDegradedState,
  isLaneVersionAtLeast2,
  LANE_EVENT_REASONS,
  LANE_TOO_OLD_COPY,
  MODEL_SOURCES,
  NOT_RECORDED_COPY,
  summariseConfigs,
  summariseFallbacks,
  summariseLaneEvents,
  summariseModelResolutions,
  summariseVerdicts,
} from "./failures";

const now = new Date("2026-08-31T12:00:00.000Z");

function createPreWave2Rows(count = 10): RoundRow[] {
  return makeRounds({ count, now }).map((row) => ({
    ...row,
    lane_version: null,
    verdict_kind: null,
    fallback_reason: null,
    model_source: null,
    config_resolution: null,
  }));
}

function createWave2NullRows(count = 10): RoundRow[] {
  return makeRounds({ count, now }).map((row) => ({
    ...row,
    lane_version: "v2.0.0",
    verdict_kind: null,
    fallback_reason: null,
    model_source: null,
    config_resolution: null,
  }));
}

function createWave2CompleteRows(): RoundRow[] {
  const base = makeRounds({ count: 12, now });
  return base.map((row, i) => {
    const verdictKind = ALL_VERDICT_KINDS[i % ALL_VERDICT_KINDS.length];
    const fallbackReason = i === 0 ? "unexpected-status-404" : i === 1 ? "unexpected-status-500" : i === 2 ? "no-baseline" : null;
    const modelSource = MODEL_SOURCES[i % MODEL_SOURCES.length];
    const configResolution = JSON.stringify({
      sources: { default_model: "workflow default" },
      layers: {
        repo_config: { outcome: i % 2 === 0 ? "ok" : "unparseable", unconsumed: [] },
        org_defaults: { outcome: "absent", unconsumed: [] },
        workflow_inputs: { outcome: "ok", unconsumed: [] },
      },
    });

    return {
      ...row,
      lane_version: "v2.0.0",
      verdict_kind: verdictKind,
      fallback_reason: fallbackReason,
      model_source: modelSource,
      config_resolution: configResolution,
    };
  });
}

function createSampleLaneEvents(): LaneEventRow[] {
  return [
    {
      run_id: 101,
      run_attempt: 1,
      recorded_at: "2026-08-31T10:00:00.000Z",
      repository: "prismalens/gh-workflows",
      reason: "no-token",
      pr_number: 12,
      head_sha: "abc1234",
      run_url: "https://github.com/prismalens/gh-workflows/actions/runs/101",
      rounds_used: null,
      lane_version: "v2.0.0",
    },
    {
      run_id: 102,
      run_attempt: 1,
      recorded_at: "2026-08-31T11:00:00.000Z",
      repository: "prismalens/gh-workflows",
      reason: "auto-paused",
      pr_number: 14,
      head_sha: "def5678",
      run_url: "https://github.com/prismalens/gh-workflows/actions/runs/102",
      rounds_used: 5,
      lane_version: "v2.0.0",
    },
  ];
}

describe("/failures - Acceptance Criteria & Degraded States", () => {
  it("with rows that all predate wave 2, every section renders its lane-too-old state and no zeros", async () => {
    const preWave2Rows = createPreWave2Rows(15);
    const api = makeFixtureApi(preWave2Rows, []);
    renderRoute({ path: "/failures", api });

    // Section 1: Verdicts
    const verdictSection = await screen.findByTestId("section-verdicts");
    expect(within(verdictSection).getByText("1. Liveness verdicts")).toBeInTheDocument();
    expect(within(verdictSection).getAllByText("lane predates field").length).toBeGreaterThan(0);
    expect(within(verdictSection).getByText(new RegExp(LANE_TOO_OLD_COPY))).toBeInTheDocument();
    expect(within(verdictSection).queryByText(/^0$/)).not.toBeInTheDocument();

    // Section 2: Fallbacks
    const fallbackSection = screen.getByTestId("section-fallbacks");
    expect(within(fallbackSection).getByText(/2. The six incremental fallbacks/)).toBeInTheDocument();
    expect(within(fallbackSection).getAllByText("lane predates field").length).toBeGreaterThan(0);
    expect(within(fallbackSection).getByText(new RegExp(LANE_TOO_OLD_COPY))).toBeInTheDocument();
    expect(within(fallbackSection).queryByText(/^0$/)).not.toBeInTheDocument();

    // Section 3: Config parse outcomes
    const configSection = screen.getByTestId("section-configs");
    expect(within(configSection).getByText(/3. Config parse outcomes/)).toBeInTheDocument();
    expect(within(configSection).getByText(new RegExp(LANE_TOO_OLD_COPY))).toBeInTheDocument();

    // Section 4: Model resolution reasons
    const modelSection = screen.getByTestId("section-model-resolution");
    expect(within(modelSection).getByText(/4. Model resolution reasons/)).toBeInTheDocument();
    expect(within(modelSection).getAllByText("lane predates field").length).toBeGreaterThan(0);
    expect(within(modelSection).getByText(new RegExp(LANE_TOO_OLD_COPY))).toBeInTheDocument();
    expect(within(modelSection).queryByText(/^0$/)).not.toBeInTheDocument();
  });

  it("with lane_version 2 and a null field, renders not-recorded state, distinguishable from lane-too-old", async () => {
    const wave2NullRows = createWave2NullRows(15);
    const api = makeFixtureApi(wave2NullRows, []);
    renderRoute({ path: "/failures", api });

    // Section 1: Verdicts
    const verdictSection = await screen.findByTestId("section-verdicts");
    expect(within(verdictSection).getAllByText("not recorded").length).toBeGreaterThan(0);
    expect(within(verdictSection).getByText(new RegExp(NOT_RECORDED_COPY))).toBeInTheDocument();
    expect(within(verdictSection).queryByText(LANE_TOO_OLD_COPY)).not.toBeInTheDocument();
    expect(within(verdictSection).queryByText("lane predates field")).not.toBeInTheDocument();
    expect(within(verdictSection).queryByText(/^0$/)).not.toBeInTheDocument();

    // Section 2: Fallbacks
    const fallbackSection = screen.getByTestId("section-fallbacks");
    expect(within(fallbackSection).getAllByText("not recorded").length).toBeGreaterThan(0);
    expect(within(fallbackSection).getByText(new RegExp(NOT_RECORDED_COPY))).toBeInTheDocument();
    expect(within(fallbackSection).queryByText(LANE_TOO_OLD_COPY)).not.toBeInTheDocument();
    expect(within(fallbackSection).queryByText("lane predates field")).not.toBeInTheDocument();

    // Section 3: Config parse outcomes
    const configSection = screen.getByTestId("section-configs");
    expect(within(configSection).getByText(new RegExp(NOT_RECORDED_COPY))).toBeInTheDocument();
    expect(within(configSection).queryByText(LANE_TOO_OLD_COPY)).not.toBeInTheDocument();

    // Section 4: Model resolution reasons
    const modelSection = screen.getByTestId("section-model-resolution");
    expect(within(modelSection).getAllByText("not recorded").length).toBeGreaterThan(0);
    expect(within(modelSection).getByText(new RegExp(NOT_RECORDED_COPY))).toBeInTheDocument();
    expect(within(modelSection).queryByText(LANE_TOO_OLD_COPY)).not.toBeInTheDocument();
    expect(within(modelSection).queryByText("lane predates field")).not.toBeInTheDocument();
  });

  it("all eight verdict kinds map to the right four-state group, and zero-count rows are present", async () => {
    const wave2Rows = createWave2CompleteRows();
    const api = makeFixtureApi(wave2Rows, []);
    renderRoute({ path: "/failures", api });

    const verdictSection = await screen.findByTestId("section-verdicts");
    expect(within(verdictSection).getByText("1. Liveness verdicts")).toBeInTheDocument();

    // All 8 verdict kinds must be present as rows
    for (const kind of ALL_VERDICT_KINDS) {
      expect(within(verdictSection).getAllByText(kind).length).toBeGreaterThan(0);
      const info = VERDICT_KIND_DEFINITIONS[kind];
      expect(within(verdictSection).getByText(info.definition)).toBeInTheDocument();
    }

    // Verify 4-state group mapping in decodeVerdict
    expect(VERDICT_KIND_MAP["reviewed"]).toBe("reviewed");
    expect(VERDICT_KIND_MAP["reviewed-incremental"]).toBe("reviewed");
    expect(VERDICT_KIND_MAP["verify-rechecked"]).toBe("threads-only");
    expect(VERDICT_KIND_MAP["auto-paused"]).toBe("did-not-run");
    expect(VERDICT_KIND_MAP["no-token"]).toBe("did-not-run");
    expect(VERDICT_KIND_MAP["no-new-commits"]).toBe("did-not-run");
    expect(VERDICT_KIND_MAP["silent"]).toBe("silent");
    expect(VERDICT_KIND_MAP["verify-silent"]).toBe("silent");

    // Check specific definition for silent
    expect(VERDICT_KIND_DEFINITIONS["silent"].definition).toBe(
      "the lane finished and posted nothing, so the head has no machine review on record",
    );
  });

  it("unexpected-status-404 and unexpected-status-500 collapse into one fallback row naming both", async () => {
    const wave2Rows = createWave2CompleteRows();
    const api = makeFixtureApi(wave2Rows, []);
    renderRoute({ path: "/failures", api });

    const fallbackSection = await screen.findByTestId("section-fallbacks");
    // Verify collapsed row naming both 404 and 500
    expect(within(fallbackSection).getByText("unexpected-status-* (404, 500)")).toBeInTheDocument();

    // Verify all six fallback reasons are present
    for (const reason of FALLBACK_REASONS) {
      if (reason === "unexpected-status-*") {
        expect(within(fallbackSection).getByText(/unexpected-status-\*/)).toBeInTheDocument();
      } else {
        expect(within(fallbackSection).getByText(reason)).toBeInTheDocument();
      }
    }
  });

  it("a fork-head count of zero renders with its footnote", async () => {
    const laneEvents: LaneEventRow[] = [
      {
        run_id: 201,
        run_attempt: 1,
        recorded_at: "2026-08-31T10:00:00.000Z",
        repository: "prismalens/gh-workflows",
        reason: "no-token",
        pr_number: 22,
        head_sha: "abc1234",
        run_url: "https://github.com/prismalens/gh-workflows/actions/runs/201",
        rounds_used: null,
        lane_version: "v2.0.0",
      },
    ];
    const api = makeFixtureApi(createWave2CompleteRows(), laneEvents);
    renderRoute({ path: "/failures", api });

    const eventsSection = await screen.findByTestId("section-lane-events");
    expect(within(eventsSection).getByText("5. Rounds that never happened")).toBeInTheDocument();
    expect(within(eventsSection).getByText("fork-head")).toBeInTheDocument();

    // Verify footnote is rendered
    const footnote = within(eventsSection).getByTestId("fork-head-footnote");
    expect(footnote).toBeInTheDocument();
    expect(footnote.textContent).toContain(FORK_HEAD_FOOTNOTE);
  });

  it("an empty range renders 'no rounds in range' and no numeric zero", async () => {
    const api = makeFixtureApi([], []);
    renderRoute({ path: "/failures", api });

    expect(await screen.findByText("No rounds in range")).toBeInTheDocument();
    expect(screen.getByText(/No rounds or lane events were recorded over/)).toBeInTheDocument();
    expect(screen.queryByTestId("section-verdicts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("section-fallbacks")).not.toBeInTheDocument();
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
  });

  it("the range control offers exactly four options and no date input", async () => {
    const api = makeFixtureApi(createWave2CompleteRows(), createSampleLaneEvents());
    const { container } = renderRoute({ path: "/failures", api });

    const group = await screen.findByRole("group", { name: "Range" });
    expect(within(group).getAllByRole("button")).toHaveLength(4);
    expect(RANGE_KEYS).toHaveLength(4);
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it("highlights default (changed-files fetch failed) with visual weight as a silent quality drop", async () => {
    const wave2Rows = createWave2CompleteRows();
    const api = makeFixtureApi(wave2Rows, []);
    renderRoute({ path: "/failures", api });

    const modelSection = await screen.findByTestId("section-model-resolution");
    expect(within(modelSection).getByText("default (changed-files fetch failed)")).toBeInTheDocument();
    expect(within(modelSection).getByText("silent quality drop")).toBeInTheDocument();
  });

  it("displays denial-tools breakdown when available under include=blobs", async () => {
    const rowsWithDenialBlobs = createWave2CompleteRows().map((row) => ({
      ...row,
      permission_denials: 3,
      raw_result: JSON.stringify({
        denial_tools: [
          { tool: "Bash", count: 2 },
          { tool: "WebFetch", count: 1 },
        ],
      }),
    }));
    const api = makeFixtureApi(rowsWithDenialBlobs, []);
    renderRoute({ path: "/failures", api });

    const modelSection = await screen.findByTestId("section-model-resolution");
    expect(within(modelSection).getByText("Bash")).toBeInTheDocument();
    expect(within(modelSection).getByText("WebFetch")).toBeInTheDocument();
  });
});

describe("failures unit aggregators and helpers", () => {
  it("correctly identifies lane_version >= 2", () => {
    expect(isLaneVersionAtLeast2(null)).toBe(false);
    expect(isLaneVersionAtLeast2(undefined)).toBe(false);
    expect(isLaneVersionAtLeast2("")).toBe(false);
    expect(isLaneVersionAtLeast2("v1.0.0")).toBe(false);
    expect(isLaneVersionAtLeast2("1")).toBe(false);
    expect(isLaneVersionAtLeast2("2")).toBe(true);
    expect(isLaneVersionAtLeast2("v2")).toBe(true);
    expect(isLaneVersionAtLeast2("v2.0.0")).toBe(true);
    expect(isLaneVersionAtLeast2("v3.1.2")).toBe(true);
  });

  it("evaluates degraded states accurately", () => {
    expect(getFieldDegradedState([], "verdict_kind")).toBe("empty");
    expect(getFieldDegradedState(createPreWave2Rows(5), "verdict_kind")).toBe("lane-too-old");
    expect(getFieldDegradedState(createWave2NullRows(5), "verdict_kind")).toBe("not-recorded");
    expect(getFieldDegradedState(createWave2CompleteRows(), "verdict_kind")).toBe("recorded");
  });

  it("summarises verdicts across all eight kinds", () => {
    const rows = createWave2CompleteRows();
    const verdicts = summariseVerdicts(rows, now);
    expect(verdicts).toHaveLength(8);
    expect(verdicts.map((v) => v.kind)).toEqual([...ALL_VERDICT_KINDS]);
  });

  it("summarises fallbacks and collapses unexpected statuses", () => {
    const rows = createWave2CompleteRows();
    const fallbacks = summariseFallbacks(rows, now);
    expect(fallbacks).toHaveLength(6);
    const unexp = fallbacks.find((f) => f.key === "unexpected-status-*");
    expect(unexp?.distinctStatuses).toEqual(["404", "500"]);
    expect(unexp?.count).toBe(2);
  });

  it("summarises configs per repo per layer", () => {
    const rows = createWave2CompleteRows();
    const { items, scannedCount } = summariseConfigs(rows);
    expect(scannedCount).toBe(rows.length);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((it) => it.layer === "repo_config")).toBe(true);
  });

  it("summarises model resolutions and denial tools", () => {
    const rows = createWave2CompleteRows();
    const { reasons, totalDenials } = summariseModelResolutions(rows, rows, now);
    expect(reasons).toHaveLength(4);
    expect(typeof totalDenials).toBe("number");
  });

  it("decodes verdict kind into the four-state groups", () => {
    expect(decodeVerdict({ verdict_kind: "silent", round_type: "full" } as never)).toBe("silent");
    expect(decodeVerdict({ verdict_kind: "verify-rechecked", round_type: "verify" } as never)).toBe("threads-only");
    expect(decodeVerdict({ verdict_kind: null, round_type: "review" } as never)).toBe("reviewed");
    expect(decodeVerdict({ verdict_kind: null, round_type: "verify" } as never)).toBe("unknown");
  });

  it("summarises lane events including footnote for fork-head", () => {
    expect(LANE_EVENT_REASONS).toHaveLength(4);
    const events = createSampleLaneEvents();
    const laneSummaries = summariseLaneEvents(events, now);
    expect(laneSummaries).toHaveLength(4);
    const forkHead = laneSummaries.find((l) => l.reason === "fork-head");
    expect(forkHead?.count).toBe(0);
    expect(forkHead?.footnote).toBe(FORK_HEAD_FOOTNOTE);
  });
});
