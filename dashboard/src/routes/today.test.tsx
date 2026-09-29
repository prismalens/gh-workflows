import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { recordingApi } from "@/test/recordingApi";
import { renderRoute } from "@/test/renderRoute";

describe("/ (Home page)", () => {
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

  it("renders a GitHub link on each NeedRow", async () => {
    const now = new Date();
    const base = makeRounds({ count: 1, now })[0];
    // silent -> headStatus "failed", so this round is a Need (#75).
    const round = {
      ...base,
      repository: "acme/payments",
      pr_number: 42,
      pr_url: "https://github.com/acme/payments/pull/42",
      pr_state: "open",
      verdict_kind: "silent",
    };
    const api = makeFixtureApi([round]);

    renderRoute({ path: "/", api });

    const link = await screen.findByRole("link", { name: "Open acme/payments#42 on GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/payments/pull/42");
  });
});
