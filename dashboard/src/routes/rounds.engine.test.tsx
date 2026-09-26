import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { renderRoute } from "@/test/renderRoute";

describe("/rounds engine filter (#185)", () => {
  const rows = makeRounds({ count: 4, now: new Date() }).map((row, i) => ({
    ...row,
    engine: i === 0 ? "opencode" : null,
  }));

  it("offers each engine, with a null one as the Actions lane, and filters by it", async () => {
    renderRoute({ path: "/rounds?range=all&engine=opencode", api: makeFixtureApi(rows) });
    const group = await screen.findByRole("group", { name: "Engine" });
    expect(within(group).getByRole("button", { name: /Actions lane/ })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: /opencode/ })).toBeInTheDocument();
    const table = await screen.findByRole("table");
    const body = within(table).getAllByRole("row").slice(1);
    const cells = body.filter((r) => within(r).queryByText("opencode"));
    expect(cells.length).toBeGreaterThan(0);
    expect(within(table).queryByText("Actions lane")).toBeNull();
  });
});
