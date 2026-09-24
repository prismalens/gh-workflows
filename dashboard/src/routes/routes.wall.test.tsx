import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { recordingApi } from "@/test/recordingApi";
import { renderRoute } from "@/test/renderRoute";

const now = new Date();
const fullApi = makeFixtureApi(makeRounds({ count: 64, now }));

describe("the API wall (#185)", () => {
  it("/repos reads the fleet route and nothing else", async () => {
    const { api, calls } = recordingApi(fullApi);
    renderRoute({ path: "/repos", api });
    await screen.findByRole("table");
    expect(new Set(calls)).toEqual(new Set(["fetchFleetRepos"]));
  });

  it("/repos?range=30d makes exactly one request, to the fleet route", async () => {
    const { api, calls } = recordingApi(fullApi);
    renderRoute({ path: "/repos?range=30d", api });
    await screen.findByRole("table");
    expect(new Set(calls)).toEqual(new Set(["fetchFleetRepos"]));
    expect(calls).toHaveLength(1);
  });

  it("/findings?view=counts reads the fleet findings route and nothing else", async () => {
    const { api, calls } = recordingApi(fullApi);
    renderRoute({ path: "/findings?view=counts", api });
    await screen.findByRole("heading", { name: "Fates" });
    expect(new Set(calls)).toEqual(new Set(["fetchFleetFindings"]));
  });
});
