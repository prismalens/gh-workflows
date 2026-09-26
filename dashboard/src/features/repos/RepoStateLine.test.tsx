import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RepoStateLine } from "./RepoStateLine";

const idle = { data: undefined, isError: false, error: null };
const state = {
  rounds: { data: undefined, isError: true, error: new Error("rounds 503") } as Record<string, unknown>,
  fleet: idle as Record<string, unknown>,
};

vi.mock("@/api/queries", () => ({
  useRoundsQuery: () => state.rounds,
  usePRsQuery: () => idle,
  useFindingsQuery: () => idle,
  useFleetReposQuery: () => state.fleet,
}));

describe("RepoStateLine", () => {
  it("shows a failed rounds request instead of rendering nothing", () => {
    render(<RepoStateLine repository="o/r" />);
    expect(screen.getByText("Could not load this repository's state")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-state-line")).toBeNull();
  });

  it("renders nothing while rounds are loaded but the fleet is still pending", () => {
    state.rounds = { data: { rows: [] }, isError: false, error: null };
    state.fleet = idle;
    render(<RepoStateLine repository="o/r" />);
    expect(screen.queryByTestId("repo-state-line")).toBeNull();
  });

  it("shows a failed fleet request instead of rendering nothing", () => {
    state.rounds = { data: { rows: [] }, isError: false, error: null };
    state.fleet = { data: undefined, isError: true, error: new Error("fleet 500") };
    render(<RepoStateLine repository="o/r" />);
    expect(screen.getByText("fleet 500")).toBeInTheDocument();
  });
});
