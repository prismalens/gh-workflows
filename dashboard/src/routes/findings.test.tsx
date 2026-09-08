import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FindingRow, PrRow } from "@/api/types";
import { makeFixtureApi } from "@/fixtures/api";
import { renderRoute } from "@/test/renderRoute";

function finding(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    thread_node_id: `PRRT_${Math.random().toString(36).slice(2)}`,
    repository: "prismalens/gh-workflows",
    pr_number: 1,
    path: "worker/index.js",
    original_line: 10,
    line: 10,
    is_resolved: 0,
    is_outdated: 0,
    resolved_by_login: null,
    thread_created_at: "2026-09-01T00:00:00.000Z",
    header_raw: "Off-by-one",
    body_excerpt: "This loop reads one past the end.",
    diff_hunk: "@@ -1,3 +1,3 @@",
    human_reply_count: 0,
    human_reply_sha: null,
    fix_sha: null,
    fix_sha_source: null,
    verify_verdict: null,
    head_sha_reviewed: "abc1234",
    last_swept_at: "2026-09-01T01:00:00.000Z",
    row_set_incomplete: 0,
    ...overrides,
  };
}

function pr(overrides: Partial<PrRow> = {}): PrRow {
  return {
    repository: "prismalens/gh-workflows",
    pr_number: 1,
    state: "open",
    title: "a pull request",
    author: "alice",
    base_ref: "main",
    head_ref: "feat",
    head_sha: "abc1234",
    merged_at: null,
    closed_at: null,
    updated_at: "2026-09-01T00:00:00.000Z",
    source: "hook",
    ...overrides,
  };
}

/** Ten rows, one per PR number, so the sparse-range rule shows tiles rather than a table. */
function tenFindings(): FindingRow[] {
  return Array.from({ length: 10 }, (_, i) =>
    finding({ pr_number: i + 1, thread_node_id: `PRRT_${i}` }),
  );
}

describe("/findings: the inbox", () => {
  it("renders the permanent honesty header naming self-grading", async () => {
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], tenFindings()) });
    expect(await screen.findByTestId("findings-honesty-header")).toBeInTheDocument();
    expect(screen.getByText(/lane's verify round grades its own findings/)).toBeInTheDocument();
  });

  it("shows tiles at n >= 10 findings, with the precise-attribution rate and never-answered count", async () => {
    const rows = tenFindings().map((r, i) => (i === 0 ? { ...r, fix_sha: "abc1234" } : r));
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });

    const strip = await screen.findByTestId("tile-strip");
    expect(within(strip).getByText("Precise-attribution rate")).toBeInTheDocument();
    expect(within(strip).getByText("Never answered")).toBeInTheDocument();
    // 1 of 10 rows carries a fix_sha.
    expect(within(strip).getByText("10.0%")).toBeInTheDocument();
  });

  it("withholds tiles for a table below the sparse-range threshold", async () => {
    const rows = [finding({ thread_node_id: "PRRT_only" })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByText(/the table below is the summary/)).toBeInTheDocument();
    expect(screen.queryByTestId("tile-strip")).not.toBeInTheDocument();
  });

  it("renders a fate chip per row and never colours self-graded green", async () => {
    const rows = [
      finding({ thread_node_id: "PRRT_never", is_resolved: 0, human_reply_count: 0 }),
      finding({
        thread_node_id: "PRRT_self",
        is_resolved: 1,
        resolved_by_login: "github-actions[bot]",
      }),
      finding({ thread_node_id: "PRRT_human", is_resolved: 1, resolved_by_login: "alice" }),
    ];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });

    const chips = await screen.findAllByTestId("fate-chip");
    const selfGraded = chips.find((c) => c.getAttribute("data-fate") === "self-graded");
    expect(selfGraded).toBeTruthy();
    expect(selfGraded!.className).not.toMatch(/3AA368/); // the resolved-by-human green
    const human = chips.find((c) => c.getAttribute("data-fate") === "resolved-by-human");
    expect(human).toBeTruthy();
  });

  it("marks a fix_sha citation and shows body/path detail with an outbound thread link", async () => {
    const rows = [finding({ fix_sha: "deadbee", fix_sha_source: "verify_table" })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByTestId("fix-cited-badge")).toBeInTheDocument();
    expect(screen.getByText("Off-by-one")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Open thread on GitHub/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/prismalens/gh-workflows/pull/1/files",
    );
  });

  it("surfaces a partial sweep on a pull request whose row_set_incomplete is set", async () => {
    const rows = [finding({ row_set_incomplete: 1 })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByText("partial sweep")).toBeInTheDocument();
  });

  it("renders the divergence list only for verdict/GitHub disagreements, never as a tile", async () => {
    const rows = [
      finding({ thread_node_id: "PRRT_agree", verify_verdict: "fixed", is_resolved: 1 }),
      finding({
        thread_node_id: "PRRT_divergent",
        verify_verdict: "fixed",
        is_resolved: 0,
        pr_number: 2,
      }),
    ];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });

    const list = await screen.findByTestId("divergence-list");
    expect(within(list).getAllByRole("row")).toHaveLength(2); // header + one divergent row
    expect(
      within(list).getByText(/marked this fixed, but the thread is still open/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/divergence.*rate/i)).not.toBeInTheDocument();
  });

  it("shows the no-divergence alert when every verdict agrees with GitHub", async () => {
    const rows = [finding({ verify_verdict: "fixed", is_resolved: 1 })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByTestId("divergence-empty")).toBeInTheDocument();
  });

  it("filters the table by the fate chip", async () => {
    const rows = [
      finding({
        thread_node_id: "PRRT_never",
        header_raw: "Never answered header",
        is_resolved: 0,
        human_reply_count: 0,
      }),
      finding({
        thread_node_id: "PRRT_human",
        header_raw: "Resolved by human header",
        is_resolved: 1,
        resolved_by_login: "alice",
      }),
    ];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });

    await screen.findByText("Resolved by human header");
    const fateGroup = screen.getByRole("group", { name: "Fate" });
    fireEvent.click(within(fateGroup).getByRole("button", { name: "resolved-by-human" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("fate-chip")).toHaveLength(1);
    });
    expect(screen.getByTestId("fate-chip")).toHaveAttribute("data-fate", "resolved-by-human");
  });

  it("searches across path, header, repository and PR number", async () => {
    const rows = [
      finding({ thread_node_id: "PRRT_a", header_raw: "Null pointer" }),
      finding({ thread_node_id: "PRRT_b", header_raw: "Off-by-one", path: "dashboard/x.ts" }),
    ];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });

    await screen.findByText("Null pointer");
    fireEvent.change(screen.getByPlaceholderText(/Search path, header/), {
      target: { value: "Null pointer" },
    });

    await waitFor(() => {
      expect(screen.queryByText("Off-by-one")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Null pointer")).toBeInTheDocument();
  });

  it("paginates the table at the selected page size", async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      finding({ thread_node_id: `PRRT_${i}`, pr_number: i + 1 }),
    );
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });

    await waitFor(() => {
      expect(screen.getAllByTestId("fate-chip")).toHaveLength(25);
    });
    expect(screen.getByText(/rows 1 to 25 of 30/)).toBeInTheDocument();
  });

  it("measures review-to-merge latency from findings against merged prs rows", async () => {
    const rows = [
      finding({ pr_number: 5, thread_created_at: "2026-09-01T00:00:00.000Z" }),
      ...tenFindings(),
    ];
    const prs = [pr({ pr_number: 5, state: "merged", merged_at: "2026-09-01T06:00:00.000Z" })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], prs, rows) });

    const strip = await screen.findByTestId("tile-strip");
    expect(within(strip).getByText("Review-to-merge latency")).toBeInTheDocument();
  });
});
