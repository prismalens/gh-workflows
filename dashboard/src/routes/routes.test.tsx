import { screen, within } from "@testing-library/react";
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

  it("explains the bounded scan when the round is outside the readable window", async () => {
    renderRoute({ path: "/rounds/does-not-exist", api });
    expect(await screen.findByText(/not in the readable window/)).toBeInTheDocument();
  });
});
