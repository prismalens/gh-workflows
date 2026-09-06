import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RoundAgentRow } from "@/api/types";
import { FanOutTimeline } from "./FanOutTimeline";

function makeAgent(overrides: Partial<RoundAgentRow> = {}): RoundAgentRow {
  return {
    session_id: "session-test-01",
    agent_id: "a1b2c3d4e5f6071829",
    subagent_type: "general-purpose",
    spawn_depth: 1,
    status: "completed",
    model: "claude-sonnet-4-6",
    input_tokens: 2000,
    output_tokens: 1000,
    cache_read_input_tokens: 50000,
    cache_creation_input_tokens: 5000,
    duration_ms: 60000,
    tool_uses: 10,
    tool_uses_by_name: JSON.stringify({ ReadFile: 6, EditFile: 4 }),
    file_paths: JSON.stringify(["src/index.ts"]),
    ...overrides,
  };
}

describe("FanOutTimeline (#89)", () => {
  it("a refused agent still renders a bar with minimum width and distinct treatment", () => {
    const refusedAgent = makeAgent({
      agent_id: "refused-001-agent",
      subagent_type: "worker",
      status: "refused",
      duration_ms: 10,
    });

    render(<FanOutTimeline agents={[refusedAgent]} wallClockMs={60000} />);

    // Bar must exist, never omitted (#89)
    const bar = screen.getByTestId("agent-bar");
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute("data-status", "refused");

    // Must have distinct styling and status badge
    const badge = screen.getByTestId("agent-status-badge");
    expect(badge).toHaveTextContent("refused");
    expect(bar.className).toContain("border-destructive");
  });

  it("a failed agent still renders a bar with distinct treatment", () => {
    const failedAgent = makeAgent({
      agent_id: "failed-002-agent",
      subagent_type: "reviewer",
      status: "failed",
      duration_ms: 500,
    });

    render(<FanOutTimeline agents={[failedAgent]} wallClockMs={60000} />);

    const bar = screen.getByTestId("agent-bar");
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute("data-status", "failed");
    expect(screen.getByTestId("agent-status-badge")).toHaveTextContent("failed");
  });

  it("an agent whose token counts are null renders with the cost encoding absent, and the legend says so", () => {
    const unknownCostAgent = makeAgent({
      agent_id: "null-tokens-agent-01",
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });

    render(<FanOutTimeline agents={[unknownCostAgent]} wallClockMs={60000} />);

    const bar = screen.getByTestId("agent-bar");
    expect(bar).toHaveAttribute("data-cost", "unknown");

    // Cost label says cost unknown
    expect(screen.getByText("cost unknown")).toBeInTheDocument();

    // Legend explicitly states cost encoding is absent for null transcript counts
    expect(screen.getByText(/cost encoding absent/i)).toBeInTheDocument();
  });

  it("a zero-cost bar and an unknown-cost bar never look the same", () => {
    const zeroCostAgent = makeAgent({
      agent_id: "zero-cost-agent",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const unknownCostAgent = makeAgent({
      agent_id: "unknown-cost-agent",
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });

    render(<FanOutTimeline agents={[zeroCostAgent, unknownCostAgent]} wallClockMs={60000} />);

    const bars = screen.getAllByTestId("agent-bar");
    expect(bars[0]).toHaveAttribute("data-cost", "zero");
    expect(bars[1]).toHaveAttribute("data-cost", "unknown");

    expect(screen.getByText("0 tokens")).toBeInTheDocument();
    expect(screen.getByText("cost unknown")).toBeInTheDocument();
  });

  it("a round with no agent rows renders the empty state and names the agents_status reason", () => {
    const reasons: Array<{ status: string; expectedText: string | RegExp }> = [
      { status: "ok", expectedText: /spawned no agents/i },
      { status: "skipped", expectedText: /skipped/i },
      { status: "no-transcript-dir", expectedText: /no transcript directory/i },
      { status: "no-execution-file", expectedText: /no execution file/i },
      { status: "no-session-id", expectedText: /no session id/i },
      { status: "parse-failed", expectedText: /could not parse|parse failed/i },
      { status: "script-failed", expectedText: /script failed/i },
    ];

    for (const { status, expectedText } of reasons) {
      const { unmount } = render(<FanOutTimeline agents={[]} agentsStatus={status} />);
      const emptyState = screen.getByTestId("agents-empty-state");
      expect(emptyState).toHaveAttribute("data-reason", status);
      expect(emptyState.textContent).toMatch(expectedText);
      unmount();
    }
  });

  it("a round with no agent rows and null agents_status names the pre-rollup reason and never falls back to subagent_stats", () => {
    render(<FanOutTimeline agents={[]} agentsStatus={null} />);
    const emptyState = screen.getByTestId("agents-empty-state");
    expect(emptyState).toHaveAttribute("data-reason", "predates-rollup");
    expect(emptyState.textContent).toMatch(/recorded before the agent rollup landed/i);
    expect(screen.queryByTestId("agent-bar")).not.toBeInTheDocument();
  });

  it("labels every agent with subagent_type and the short agent_id", () => {
    const agent = makeAgent({
      agent_id: "c0ffee1234567890abcdef",
      subagent_type: "general-purpose",
    });

    render(<FanOutTimeline agents={[agent]} wallClockMs={60000} />);

    const label = screen.getByTestId("agent-label");
    expect(within(label).getByText("general-purpose")).toBeInTheDocument();
    expect(within(label).getByText("c0ffee12")).toBeInTheDocument();
  });

  it("renders spawn depth as a badge, not a tree nesting", () => {
    const agent = makeAgent({ spawn_depth: 2 });
    render(<FanOutTimeline agents={[agent]} wallClockMs={60000} />);

    expect(screen.getByText("d=2")).toBeInTheDocument();
  });
});
