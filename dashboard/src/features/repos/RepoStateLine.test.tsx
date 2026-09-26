import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RepoStateLine } from "./RepoStateLine";

const idle = { data: undefined, isError: false, error: null };

vi.mock("@/api/queries", () => ({
  useRoundsQuery: () => ({ data: undefined, isError: true, error: new Error("rounds 503") }),
  usePRsQuery: () => idle,
  useFindingsQuery: () => idle,
  useFleetReposQuery: () => idle,
}));

describe("RepoStateLine", () => {
  it("shows a failed rounds request instead of rendering nothing", () => {
    render(<RepoStateLine repository="o/r" />);
    expect(screen.getByText("Could not load this repository's state")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-state-line")).toBeNull();
  });
});
