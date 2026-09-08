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
    // The latency hint must not claim the finding stayed open the whole time - the
    // metric never reads is_resolved (PR 161 review).
    expect(
      within(strip).getByText(/time from the first recorded finding to merge/),
    ).toBeInTheDocument();
    expect(within(strip).queryByText(/an open finding sat before merge/)).not.toBeInTheDocument();
  });

  it("withholds tiles for a table below the sparse-range threshold, naming findings, not rounds", async () => {
    const rows = [finding({ thread_node_id: "PRRT_only" })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByText(/the table below is the summary/)).toBeInTheDocument();
    expect(screen.queryByTestId("tile-strip")).not.toBeInTheDocument();
    // #75 path_instructions: a label must be backed by what it counts. This strip counts
    // findings, so its copy must not borrow the rounds-flavored wording from the overview page.
    expect(screen.getByText(/1 finding over/)).toBeInTheDocument();
    expect(screen.getByText(/withheld under 10 findings/)).toBeInTheDocument();
    expect(screen.queryByText(/rounds/)).not.toBeInTheDocument();
  });

  it("a repository with zero findings says so as an absence of findings, never as 'no rounds in range' (finding this pass)", async () => {
    // A repository can be reviewed cleanly for a long time, or never swept at all; either way
    // zero finding rows is not zero rounds, and the copy must not assert the wrong absence.
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], []) });
    expect(await screen.findByText(/No findings in range/)).toBeInTheDocument();
    expect(screen.getByText(/not proof that every reviewed pull request here was clean/)).toBeInTheDocument();
    expect(screen.queryByText(/No rounds in range/)).not.toBeInTheDocument();
    expect(screen.queryByText(/a run that cost nothing/)).not.toBeInTheDocument();
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

  it("marks a fix_sha citation and shows body/path detail with an outbound link that does not overclaim (this pass)", async () => {
    const rows = [finding({ fix_sha: "deadbee", fix_sha_source: "verify_table" })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByTestId("fix-cited-badge")).toBeInTheDocument();
    expect(screen.getByText("Off-by-one")).toBeInTheDocument();
    // The URL is the PR's files tab - review_findings stores no thread URL and the
    // GraphQL thread id has no REST equivalent (#111), so the link cannot open the
    // specific thread. "Open thread on GitHub" asserted a specificity this row cannot
    // support; the label must not claim more than the href delivers.
    const link = screen.getByRole("link", { name: /View PR files on GitHub/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/prismalens/gh-workflows/pull/1/files",
    );
    expect(screen.queryByText(/Open thread on GitHub/)).not.toBeInTheDocument();
  });

  it("surfaces a partial sweep on a pull request whose row_set_incomplete is set", async () => {
    const rows = [finding({ row_set_incomplete: 1 })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByText("partial sweep")).toBeInTheDocument();
  });

  it("a page-limited read says how many were read, never blaming the sweep's own throttle (#111 table contract)", async () => {
    // MAX_LIMIT rows so the fixture's fetchFindings hands back a non-null next_cursor,
    // exactly the API read-window limit #111 rules "no page walking" for. This is a
    // different fact than row_set_incomplete (the sweep's own GraphQL throttle, covered
    // by the partial-sweep badge above) and the two must not read as the same cause.
    const rows = Array.from({ length: 1000 }, (_, i) =>
      finding({ thread_node_id: `PRRT_${i}`, pr_number: i + 1 }),
    );
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });

    expect(await screen.findByText(/1,000 most recent findings are shown\./)).toBeInTheDocument();
    expect(screen.queryByText(/throttle cut the sweep/)).not.toBeInTheDocument();
    expect(screen.queryByText(/throttle cut the underlying sweep/)).not.toBeInTheDocument();
    expect(screen.queryByText("partial sweep")).not.toBeInTheDocument();
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
    // Same overclaim as the findings table (this pass): the link is the PR's files
    // tab, never a specific thread, so the label must not say "thread".
    const link = within(list).getByRole("link", { name: /View PR files on GitHub/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/prismalens/gh-workflows/pull/2/files",
    );
  });

  it("shows the no-divergence alert when every verdict agrees with GitHub", async () => {
    const rows = [finding({ verify_verdict: "fixed", is_resolved: 1 })];
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByTestId("divergence-empty")).toBeInTheDocument();
  });

  it("with zero findings and no filter selected, says so as an empty window, never as filters excluding rows (this pass)", async () => {
    renderRoute({ path: "/findings", api: makeFixtureApi([], [], [], [], [], []) });
    expect(
      await screen.findByText(/No findings recorded in the loaded window/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not proof every reviewed pull request here was clean/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No findings match the selected filters/)).not.toBeInTheDocument();
  });

  it("with a fate filter selected that matches nothing, still blames the selected filters", async () => {
    const rows = [finding({ thread_node_id: "PRRT_only", is_resolved: 0, human_reply_count: 0 })];
    renderRoute({ path: "/findings?fate=resolved-by-human", api: makeFixtureApi([], [], [], [], [], rows) });
    expect(await screen.findByText("No findings match the selected filters.")).toBeInTheDocument();
    expect(
      screen.queryByText(/No findings recorded in the loaded window/),
    ).not.toBeInTheDocument();
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
