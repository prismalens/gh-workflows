import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { recordingApi } from "@/test/recordingApi";
import { renderRoute } from "@/test/renderRoute";

describe("/ (Today page)", () => {
  it("renders the status strip, Needs you, and This week sections", async () => {
    const baseApi = makeFixtureApi(makeRounds({ count: 10, now: new Date() }));
    const { api, calls } = recordingApi(baseApi);

    renderRoute({ path: "/", api });

    expect(await screen.findByTestId("status-strip")).toBeInTheDocument();
    expect(screen.getByTestId("needs-you")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByTestId("this-week")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "This week" })).toBeInTheDocument();

    expect(calls).toContain("fetchRuns");
    expect(calls).toContain("fetchPRs");
    expect(calls).toContain("fetchFindings");
    expect(calls).toContain("fetchFleetRepos");
  });
});
