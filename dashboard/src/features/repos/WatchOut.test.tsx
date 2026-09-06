import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WatchOut, type WatchOutProps } from "./WatchOut";

/** WatchOut links to /failures and /rounds, so it needs a router in scope. */
async function renderWatchOut(props: WatchOutProps) {
  const rootRoute = createRootRoute({ component: () => <WatchOut {...props} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/repos"] }),
  });
  render(<RouterProvider router={router} />);
  return screen.findByTestId("watch-out");
}

describe("WatchOut", () => {
  it("renders the one muted line when there is nothing to watch", async () => {
    const card = await renderWatchOut({
      malformed: [],
      quiet: [],
      range: "rolling",
      windowLabel: "the last 7 days",
    });
    expect(card).toHaveTextContent("Nothing to watch in this window.");
  });

  it("names a malformed layer with a link to the failures page, current range carried", async () => {
    const card = await renderWatchOut({
      malformed: [{ repository: "o/broken", layer: "Repo config" }],
      quiet: [],
      range: "90d",
      windowLabel: "the last 90 days",
    });
    expect(card).toHaveTextContent(
      "o/broken: Repo config layer malformed, lane on workflow defaults",
    );
    const link = screen.getByRole("link", { name: "o/broken" });
    const href = decodeURIComponent(link.getAttribute("href") ?? "");
    expect(href).toContain("/failures");
    expect(href).toContain("range=90d");
    expect(href).toContain("repository=o/broken");
  });

  it("names a quiet repository with its last round and a link to its all-time rounds", async () => {
    const card = await renderWatchOut({
      malformed: [],
      quiet: [{ repository: "o/quiet", lastRoundAt: "2026-07-15T08:14:00.000Z" }],
      range: "rolling",
      windowLabel: "the last 7 days",
    });
    expect(card.textContent).toContain("o/quiet: no round in the last 7 days, last round");
    const link = screen.getByRole("link", { name: "o/quiet" });
    const href = decodeURIComponent(link.getAttribute("href") ?? "");
    expect(href).toContain("/rounds");
    expect(href).toContain("range=all");
    expect(href).toContain("repository=o/quiet");
  });

  it("footnotes that a quiet repository and a dead lane look the same, linking to failures", async () => {
    const card = await renderWatchOut({
      malformed: [],
      quiet: [],
      range: "rolling",
      windowLabel: "the last 7 days",
    });
    expect(card).toHaveTextContent(
      "A quiet repository and a dead lane look the same here, until lane events say otherwise.",
    );
    const link = screen.getByRole("link", { name: "lane events" });
    expect(link.getAttribute("href")).toContain("/failures");
  });
});
