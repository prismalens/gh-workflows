import { cleanup, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { LIST_RATE_EQUIVALENT } from "@/honesty/thresholds";
import { renderRoute } from "@/test/renderRoute";

// Rounds are laid out backwards from the moment the test runs, so the rolling
// window covers the same rows whatever day CI happens to run on.
const now = new Date();
const fullApi = makeFixtureApi(makeRounds({ count: 64, now }));
const sparseApi = makeFixtureApi(makeRounds({ count: 6, now, seed: 11 }));
const emptyApi = makeFixtureApi([]);

describe("/", () => {
  it("redirects to the rounds table", async () => {
    renderRoute({ path: "/", api: fullApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rolling" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("a fixtures build says the rounds are invented", () => {
  it("shows a persistent banner whenever the fixture table is behind the page", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    expect(await screen.findByTestId("fixture-banner")).toHaveTextContent(
      /every round on this page is invented/i,
    );
  });
});

describe("/rounds", () => {
  it("renders the table against fixture data", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
    expect(screen.getAllByText("prismalens/sreforge").length).toBeGreaterThan(0);
  });

  it("puts n on every tile it renders", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    const counts = await screen.findAllByTestId("tile-n");
    expect(counts).toHaveLength(5);
    for (const count of counts) {
      expect(count).toHaveTextContent(/^n = \d+$/);
    }
  });

  it("labels total_cost_usd as the list-rate equivalent and keeps it out of the tiles", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    const table = await screen.findByRole("table");
    expect(within(table).getByText(LIST_RATE_EQUIVALENT)).toBeInTheDocument();

    const tiles = screen.getByTestId("tile-strip");
    expect(tiles.textContent).not.toMatch(/\$/);
    expect(tiles.textContent).not.toMatch(/cost|usd/i);
  });

  it("offers four range buttons and no date picker", async () => {
    const { container } = renderRoute({ path: "/rounds", api: fullApi });
    const group = await screen.findByRole("group", { name: "Range" });
    expect(within(group).getAllByRole("button")).toHaveLength(4);
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it("reads the range out of the URL, so a filtered view is shareable", async () => {
    renderRoute({ path: "/rounds?range=90d&repository=prismalens%2Fsreforge", api: fullApi });
    expect(await screen.findByText(/Over the last 90 days/)).toBeInTheDocument();
    const rows = await screen.findAllByRole("row");
    const repositories = rows
      .slice(1)
      .map((row) => within(row).queryByText(/^[\w-]+\/[\w-]+$/)?.textContent)
      .filter(Boolean);
    expect(new Set(repositories)).toEqual(new Set(["prismalens/sreforge"]));
  });

  it("falls back to the default range when the URL carries a bad one", async () => {
    renderRoute({ path: "/rounds?range=last-tuesday", api: fullApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rolling" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders the round table instead of tiles when the range is thin", async () => {
    renderRoute({ path: "/rounds", api: sparseApi });
    expect(await screen.findByText(/the table below is the summary/)).toBeInTheDocument();
    expect(screen.queryByTestId("tile-n")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("says no rounds in range rather than showing zeros", async () => {
    renderRoute({ path: "/rounds", api: emptyApi });
    expect((await screen.findAllByText("No rounds in range")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("/rounds/$sessionId", () => {
  const rows = makeRounds({ count: 64, now });
  const api = makeFixtureApi(rows);
  const withFanOut = rows.find((row) => row.round_type === "incremental")!;
  const verify = rows.find((row) => row.round_type === "verify")!;

  const detailPath = (sessionId: string, at: string) =>
    `/rounds/${sessionId}?at=${encodeURIComponent(at)}`;

  it("renders all six panels", async () => {
    renderRoute({ path: detailPath(withFanOut.session_id, withFanOut.recorded_at), api });
    for (const title of [
      "Resolution",
      "Timing",
      "Fan-out",
      "Tokens",
      "Permission denials",
      "Raw record",
    ]) {
      expect(await screen.findByText(title)).toBeInTheDocument();
    }
  });

  it("labels the fan-out approximate and refuses to draw per-agent bars", async () => {
    renderRoute({ path: detailPath(withFanOut.session_id, withFanOut.recorded_at), api });
    expect(await screen.findByTestId("approximate")).toBeInTheDocument();
    const perAgent = (await screen.findAllByTestId("degraded")).find((node) =>
      node.textContent?.includes("Per-agent breakdown"),
    );
    expect(perAgent).toHaveAttribute("data-reason", "unbuilt");
  });

  it("separates a field the lane never sent from one that is not built yet", async () => {
    renderRoute({ path: detailPath(verify.session_id, verify.recorded_at), api });
    const degraded = await screen.findAllByTestId("degraded");
    const reasons = new Set(degraded.map((node) => node.getAttribute("data-reason")));
    expect(reasons).toContain("lane-did-not-send");
    expect(reasons).toContain("unbuilt");
    expect(
      degraded.some((node) => node.textContent?.includes("Subagent lifecycle counts")),
    ).toBe(true);
  });

  it("reads a fan-out round's summed API time as parallelism, never negative overhead", async () => {
    // The artboards show API time exceeding wall clock, because duration_api_ms is
    // summed across concurrent agents. Subtracting would render a negative duration.
    const parallel = { ...rows[0], duration_ms: 338_000, duration_api_ms: 493_000 };
    const one = makeFixtureApi([parallel]);
    renderRoute({ path: detailPath(parallel.session_id, parallel.recorded_at), api: one });

    expect(await screen.findByText("Parallelism")).toBeInTheDocument();
    expect(screen.getByText("1.46x")).toBeInTheDocument();
    expect(screen.queryByText("Outside the API")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/-\d+m/);
  });

  it("explains the bounded scan when the round is outside the readable window", async () => {
    renderRoute({ path: "/rounds/does-not-exist", api });
    expect(await screen.findByText(/not in the readable window/)).toBeInTheDocument();
  });
});

describe("a nulled column is absent, never smallest", () => {
  // duration_ms comes through unguarded from the workflow, so null is live data.
  const rows = makeRounds({ count: 12, now, seed: 5 });
  const withNulls = rows.map((row, i) =>
    i < 4
      ? {
          ...row,
          duration_ms: null,
          num_turns: null,
          permission_denials: null,
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
        }
      : row,
  );
  const api = makeFixtureApi(withNulls);

  const wallClockColumn = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[5]?.textContent?.trim() ?? "");

  it("sorts nulled wall clocks last, ascending and descending", async () => {
    renderRoute({ path: "/rounds?sort=duration_ms&dir=asc", api });
    await screen.findByRole("table");
    const asc = wallClockColumn();
    expect(asc.slice(-4)).toEqual(["—", "—", "—", "—"]);
    expect(asc[0]).not.toBe("—");

    cleanup();
    renderRoute({ path: "/rounds?sort=duration_ms&dir=desc", api });
    await screen.findByRole("table");
    const desc = wallClockColumn();
    expect(desc.slice(-4)).toEqual(["—", "—", "—", "—"]);
  });

  it("renders a missing token count as absent rather than as the lightest round", async () => {
    renderRoute({ path: "/rounds?sort=billable_tokens&dir=asc", api });
    await screen.findByRole("table");
    const tokens = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[8]?.textContent?.trim() ?? "");
    expect(tokens.slice(-4)).toEqual(["—", "—", "—", "—"]);
    expect(tokens).not.toContain("0");
  });

  it("sorts a nulled list-rate equivalent last too", async () => {
    renderRoute({ path: "/rounds?sort=total_cost_usd&dir=asc", api });
    await screen.findByRole("table");
    const costs = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[9]?.textContent?.trim() ?? "");
    expect(costs.slice(-4)).toEqual(["—", "—", "—", "—"]);
  });
});
