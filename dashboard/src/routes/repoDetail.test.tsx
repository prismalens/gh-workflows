import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { healthReportsUrl, httpApi } from "@/api/client";
import type { HealthReportRow } from "@/api/types";
import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { renderRoute } from "@/test/renderRoute";

const REPO = "prismalens/gh-workflows";

function healthRow(overrides: Partial<HealthReportRow> = {}): HealthReportRow {
  return {
    id: 1,
    repository: REPO,
    repository_id: 12345,
    window_start: "2026-09-14T00:00:00Z",
    window_end: "2026-09-21T00:00:00Z",
    runs_seen: 40,
    runs_accounted: 40,
    unaccounted_runs: "[]",
    startup_failures: 0,
    lane_events_by_reason: "{}",
    findings_swept: 5,
    share: "full",
    ingest_auth: "oidc",
    received_at: "2026-09-21T06:00:00.000Z",
    ...overrides,
  };
}

function apiWith(reports: HealthReportRow[]) {
  return makeFixtureApi(makeRounds({ count: 8 }), [], [], [], [], [], reports);
}

describe("GET /api/health-reports is called in the shape worker/index.js accepts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends repository, limit and cursor, and omits absent ones", () => {
    expect(healthReportsUrl({ repository: "a/b", limit: 200 })).toBe(
      "/api/health-reports?repository=a%2Fb&limit=200",
    );
    expect(healthReportsUrl()).toBe("/api/health-reports");
  });

  it("rejects a row missing a column and accepts the Worker's row", async () => {
    const respond = (body: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    const { ingest_auth: _dropped, ...partial } = healthRow();
    respond({ rows: [partial], next_cursor: null });
    await expect(httpApi.fetchHealthReports()).rejects.toMatchObject({ kind: "malformed" });

    respond({ rows: [healthRow({ repository_id: null, ingest_auth: "bearer" })], next_cursor: null });
    await expect(httpApi.fetchHealthReports()).resolves.toMatchObject({ rows: [{ id: 1 }] });
  });

  it("the fixture pages by window_start|id without repeating or skipping a row", async () => {
    const api = apiWith([
      healthRow({ id: 1 }),
      healthRow({ id: 2 }),
      healthRow({ id: 3, window_start: "2026-09-07T00:00:00Z" }),
    ]);
    const first = await api.fetchHealthReports({ limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([2, 1]);
    expect(first.next_cursor).toBe("2026-09-14T00:00:00Z|1");
    const second = await api.fetchHealthReports({ limit: 2, cursor: first.next_cursor! });
    expect(second.rows.map((r) => r.id)).toEqual([3]);
    expect(second.next_cursor).toBeNull();
  });
});

describe("/repos/$owner/$repo: the weekly health tab (#179)", () => {
  it("is where each /repos row links", async () => {
    renderRoute({ path: "/repos", api: makeFixtureApi(makeRounds({ count: 64 })) });
    const table = await screen.findByRole("table");
    const link = within(table).getByRole("link", { name: "prismalens/sreforge" });
    expect(link).toHaveAttribute("href", "/repos/prismalens/sreforge");
  });

  it("lists every row as it arrived, newest window first, for this repository only", async () => {
    const api = apiWith([
      healthRow({ id: 3, window_start: "2026-09-07T00:00:00Z", window_end: "2026-09-14T00:00:00Z" }),
      // Two rows for one window: tiling rows of an oversize week, or a re-run.
      healthRow({ id: 5, runs_seen: 11, runs_accounted: 11 }),
      healthRow({ id: 6, runs_seen: 29, runs_accounted: 29 }),
      healthRow({ id: 7, repository: "prismalens/sreforge", runs_seen: 999 }),
    ]);
    const spy = vi.spyOn(api, "fetchHealthReports");
    renderRoute({ path: `/repos/${REPO}`, api });

    const panel = await screen.findByTestId("weekly-health");
    expect(screen.getByRole("heading", { name: REPO })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Weekly health" })).toHaveAttribute("aria-selected", "true");

    const rows = within(panel).getAllByTestId("health-row");
    expect(rows).toHaveLength(3);
    const runsSeen = rows.map((row) => within(row).getAllByRole("cell")[1].textContent);
    expect(runsSeen).toEqual(["29", "11", "40"]);
    expect(within(panel).queryByText("999")).toBeNull();

    expect(spy).toHaveBeenCalledWith({ repository: REPO, limit: 200, include: "blobs" });
  });

  it("expands unaccounted runs into links to their Actions runs, and shows lane events and ingest", async () => {
    const api = apiWith([
      healthRow({
        runs_seen: 40,
        runs_accounted: 38,
        unaccounted_runs: JSON.stringify([
          { id: 901, conclusion: "startup_failure", created_at: "2026-09-15T10:00:00Z" },
          { id: 902, conclusion: "cancelled", created_at: "2026-09-16T10:00:00Z" },
        ]),
        startup_failures: 1,
        lane_events_by_reason: JSON.stringify({ "auto-paused": 2, "no-token": 5 }),
      }),
      healthRow({ id: 2, window_start: "2026-09-07T00:00:00Z", repository_id: null, ingest_auth: "bearer" }),
    ]);
    renderRoute({ path: `/repos/${REPO}`, api });

    const [first, second] = await screen.findAllByTestId("health-row");
    fireEvent.click(within(first).getByText("2"));
    const run = within(first).getByRole("link", { name: /901/ });
    expect(run).toHaveAttribute("href", `https://github.com/${REPO}/actions/runs/901`);
    expect(within(first).getByText("startup_failure")).toBeInTheDocument();
    expect(within(first).getByText("no-token 5")).toBeInTheDocument();
    expect(within(first).getByText("auto-paused 2")).toBeInTheDocument();
    expect(within(first).getByText("OIDC, repository id 12345")).toBeInTheDocument();
    expect(within(second).getByText("bearer")).toBeInTheDocument();
    expect(within(second).getByText("none")).toBeInTheDocument();
  });

  it("marks a JSON column that does not parse as unreadable, not as zero", async () => {
    const api = apiWith([
      healthRow({ runs_accounted: 37, unaccounted_runs: "not json", lane_events_by_reason: "[]" }),
    ]);
    renderRoute({ path: `/repos/${REPO}`, api });

    const row = await screen.findByTestId("health-row");
    const degraded = within(row).getAllByTestId("degraded");
    expect(degraded).toHaveLength(2);
    for (const d of degraded) expect(d).toHaveAttribute("data-reason", "unreadable");
    expect(within(row).getByText(/3 by count; the run list did not parse/)).toBeInTheDocument();
  });

  it("says no report has arrived rather than showing an empty table", async () => {
    renderRoute({ path: `/repos/${REPO}`, api: apiWith([]) });
    expect(await screen.findByText(`No health report has arrived for ${REPO}`)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the state Home shows for the same repository (#218)", async () => {
    const rounds = makeRounds({ count: 8, now: new Date() });
    const repository = rounds[0]!.repository;
    const api = makeFixtureApi(rounds, [], [], [], [], [], []);

    const home = renderRoute({ path: "/", api });
    const table = await screen.findByTestId("today-repos");
    const row = within(table).getByRole("link", { name: repository }).closest("tr")!;
    const homeState = row.querySelectorAll("td")[1]!.textContent;
    home.unmount();

    renderRoute({ path: `/repos/${repository}`, api });
    const line = await screen.findByTestId("repo-state-line");
    expect(homeState).toBeTruthy();
    expect(line.textContent).toContain(`${homeState} ·`);
    expect(await screen.findByText(`No health report has arrived for ${repository}`)).toBeInTheDocument();
  });

  it("says so when the Worker has more rows than one page", async () => {
    const reports = Array.from({ length: 201 }, (_, i) =>
      healthRow({ id: i + 1, window_start: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` }),
    );
    renderRoute({ path: `/repos/${REPO}`, api: apiWith(reports) });
    await waitFor(() =>
      expect(screen.getByText(/Only the newest 200 reports are shown/)).toBeInTheDocument(),
    );
  });
});
