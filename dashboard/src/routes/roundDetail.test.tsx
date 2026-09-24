import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RoundAgentRow, RoundRow } from "@/api/types";
import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { fieldEra, LANE_4_STRADDLES, LANE_VERSION_UNKNOWN } from "@/honesty/fieldEra";
import { renderRoute } from "@/test/renderRoute";

const now = new Date();
const base: RoundRow = {
  ...makeRounds({ count: 1, now })[0],
  verdict_kind: "clean",
};
const detailPath = (row: RoundRow) =>
  `/rounds/${row.session_id}?at=${encodeURIComponent(row.recorded_at)}`;

const lane5: RoundRow = {
  ...base,
  lane_version: "5",
  job_conclusion: "success",
  credential_type: "oauth",
  base_pr_number: 42,
  patch_fingerprint: "0123456789abcdef".repeat(4),
  context_repositories: 2,
  context_lines: 340,
  ingest_auth: "oidc",
  repository_id: 987654,
};

function render(row: RoundRow, agents: RoundAgentRow[] = []) {
  renderRoute({
    path: detailPath(row),
    api: makeFixtureApi([row], [], [], agents),
  });
}

function fact(label: string): HTMLElement {
  return screen.getByText(label, { selector: "dt" }).parentElement!;
}

function degraded(what: string): HTMLElement | undefined {
  return screen.queryAllByTestId("degraded").find((node) => node.textContent?.includes(what));
}

describe("fieldEra (#179)", () => {
  it("rules by lane version: 5 sent nothing, 4 straddles, older predates", () => {
    expect(fieldEra({ lane_version: "5" }).reason).toBe("lane-sent-nothing");
    expect(fieldEra({ lane_version: "v6.1.0" }).reason).toBe("lane-sent-nothing");
    const four = fieldEra({ lane_version: "4" });
    expect(four.reason).toBe("lane-did-not-send");
    expect(four.detail).toBe(LANE_4_STRADDLES);
    expect(four.label).toBe("not recorded by this lane version");
    expect(fieldEra({ lane_version: "v2.0.0" }).detail).toMatch(/Lane 2 predates/);
  });

  it("claims no era for a round with no readable lane version", () => {
    for (const lane_version of [null, "", "nightly"]) {
      const era = fieldEra({ lane_version });
      expect(era.reason).toBe("not-recorded");
      expect(era.detail).toBe(LANE_VERSION_UNKNOWN);
      expect(era.detail).not.toMatch(/predates/);
    }
  });
});

describe("/rounds/$sessionId resolution facts (#179)", () => {
  it("names the credential in the Keys vocabulary and links the stacked base", async () => {
    render(lane5);
    await screen.findByText("Resolution");
    expect(fact("Credential")).toHaveTextContent("subscription OAuth");
    const stacked = within(fact("Stacked on")).getByRole("link");
    expect(stacked).toHaveTextContent("#42");
    expect(stacked).toHaveAttribute("href", `https://github.com/${lane5.repository}/pull/42`);
    expect(fact("Patch fingerprint")).toHaveTextContent(/^Patch fingerprint0123456789ab$/);
    expect(fact("Context")).toHaveTextContent("2 repositories, 340 lines");
    expect(fact("Ingest")).toHaveTextContent("OIDC, repository id 987654");
    expect(degraded("Credential")).toBeUndefined();
  });

  it("reads zero context as none, a null base as none, and bearer as bearer", async () => {
    render({
      ...lane5,
      credential_type: "api_key",
      context_repositories: 0,
      context_lines: 0,
      base_pr_number: null,
      ingest_auth: "bearer",
      repository_id: null,
    });
    await screen.findByText("Resolution");
    expect(fact("Credential")).toHaveTextContent("metered API key");
    expect(fact("Context")).toHaveTextContent(/^Contextnone$/);
    expect(fact("Stacked on")).toHaveTextContent(/^Stacked onnone$/);
    expect(fact("Ingest")).toHaveTextContent(/^Ingestbearer$/);
    expect(
      screen.queryAllByTestId("degraded").some((n) => n.dataset.reason === "lane-sent-nothing"),
    ).toBe(false);
  });

  it("says a lane-5 round sent nothing when the fields are null", async () => {
    render({
      ...lane5,
      credential_type: null,
      patch_fingerprint: null,
      context_repositories: null,
      context_lines: null,
    });
    await screen.findByText("Resolution");
    expect(fact("Credential")).toHaveTextContent("not recorded for this round");
    const gap = degraded("Credential, Patch fingerprint, Context");
    expect(gap).toHaveAttribute("data-reason", "lane-sent-nothing");
  });

  it("says an older lane never recorded them, never 0 or missing", async () => {
    const lane4: RoundRow = { ...base, lane_version: "4" };
    render(lane4);
    await screen.findByText("Resolution");
    expect(fact("Credential")).toHaveTextContent("not recorded by this lane version");
    expect(fact("Context")).toHaveTextContent("not recorded by this lane version");
    expect(fact("Context")).not.toHaveTextContent("0");
    expect(fact("Ingest")).toHaveTextContent("recorded before identity, #177");
    const gap = degraded("Credential, Patch fingerprint, Context");
    expect(gap).toHaveAttribute("data-reason", "lane-did-not-send");
    expect(gap).toHaveTextContent(LANE_4_STRADDLES);
  });
  it("names the gap without a cause when the round has no lane version", async () => {
    render({ ...base, lane_version: null });
    await screen.findByText("Resolution");
    expect(fact("Credential")).toHaveTextContent(/^Credentialnot recorded$/);
    const gap = degraded("Credential, Patch fingerprint, Context");
    expect(gap).toHaveAttribute("data-reason", "not-recorded");
    expect(gap).toHaveTextContent(LANE_VERSION_UNKNOWN);
    expect(gap).not.toHaveTextContent(/predates/);
  });
});

describe("/rounds/$sessionId failure panel (#179)", () => {
  it("is absent on a round that succeeded", async () => {
    render(lane5);
    await screen.findByText("Resolution");
    expect(screen.queryByText("Failure")).not.toBeInTheDocument();
  });

  it("explains a classified failure with its retry advice and reset time", async () => {
    render({
      ...lane5,
      verdict_kind: "api-error",
      job_conclusion: "failure",
      failure_class: "account-limit",
      failure_retryable: 0,
      failure_reset_at: "2026-09-20T10:00:00Z",
      api_error_status: 429,
    });
    await screen.findByText("Failure");
    expect(fact("Class")).toHaveTextContent("account limit");
    expect(fact("Waiting helps")).toHaveTextContent(/no$/);
    expect(within(fact("Resets")).getByTitle("2026-09-20T10:00:00Z")).toBeInTheDocument();
    expect(fact("API status")).toHaveTextContent("429");
    expect(screen.getByText(/session or weekly limit/)).toBeInTheDocument();
  });

  it("says no reset time was recorded when there is none", async () => {
    render({
      ...lane5,
      job_conclusion: "failure",
      failure_class: "rate-limited",
      failure_retryable: 1,
      failure_reset_at: null,
      api_error_status: 429,
    });
    await screen.findByText("Failure");
    expect(fact("Waiting helps")).toHaveTextContent(/yes$/);
    expect(fact("Resets")).toHaveTextContent("no reset time recorded");
  });

  it("degrades an unclassified failure by lane era", async () => {
    render({ ...lane5, job_conclusion: "failure", failure_class: null });
    await screen.findByText("Failure");
    expect(degraded("Failure class")).toHaveAttribute("data-reason", "lane-sent-nothing");
  });

  it("marks an older lane's unclassified failure as predating the field", async () => {
    render({
      ...base,
      lane_version: "4",
      verdict_kind: "api-error",
      job_conclusion: "failure",
    });
    await screen.findByText("Failure");
    const gap = degraded("Failure class");
    expect(gap).toHaveAttribute("data-reason", "lane-did-not-send");
    expect(gap).toHaveTextContent(LANE_4_STRADDLES);
  });
});

function agent(overrides: Partial<RoundAgentRow>): RoundAgentRow {
  return {
    session_id: lane5.session_id,
    agent_id: "a1",
    subagent_type: "code-reviewer",
    spawn_depth: 1,
    status: "completed",
    model: "claude-opus-4-6",
    input_tokens: 10,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    duration_ms: 1000,
    tool_uses: 6,
    tool_uses_by_name: null,
    file_paths: null,
    tool_detail: null,
    harness_paths_count: null,
    ...overrides,
  };
}

const TOOL_DETAIL = JSON.stringify({
  read: [
    {
      path: "src/a.ts",
      calls: 2,
      offset_max: 0,
      limit_max: 0,
      lines_returned: 40,
    },
    {
      path: "src/b.ts",
      calls: 1,
      offset_max: 0,
      limit_max: 0,
      lines_returned: 10,
    },
  ],
  grep: [{ pattern: "TODO", path: "src", glob: null, calls: 1, matches: 3 }],
  glob: [],
  bash: { "gh pr view": 2 },
  other: { WebFetch: 1 },
});

describe("/rounds/$sessionId agent tools panel (#179)", () => {
  it("counts each agent's calls by tool and keeps paths folded, unlinked", async () => {
    render(lane5, [agent({ tool_detail: TOOL_DETAIL, harness_paths_count: 4 })]);
    const row = await screen.findByTestId("agent-tools-row");
    const cells = within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells).toEqual(["code-reviewer", "3", "1", "0", "2", "1", "4"]);
    expect(within(row).queryByText("truncated")).not.toBeInTheDocument();

    const summary = screen.getByText(/Paths and patterns/);
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText(/src\/a\.ts/)).toBeInTheDocument();
    expect(within(details).getByText(/TODO in src/)).toBeInTheDocument();
    expect(within(details).queryAllByRole("link")).toHaveLength(0);
  });

  it("badges a truncated breakdown", async () => {
    const truncated = JSON.stringify({
      ...JSON.parse(TOOL_DETAIL),
      tool_detail_truncated: true,
    });
    render(lane5, [agent({ tool_detail: truncated })]);
    const row = await screen.findByTestId("agent-tools-row");
    expect(within(row).getByText("truncated")).toBeInTheDocument();
  });

  it("degrades an agent with no tool detail by the parent round's lane era", async () => {
    render({ ...base, lane_version: "4" }, [
      agent({ session_id: base.session_id, tool_detail: null }),
    ]);
    const row = await screen.findByTestId("agent-tools-row");
    expect(within(row).getAllByRole("cell")[1]).toHaveTextContent("—");
    const gap = degraded("Tool detail for 1 of 1 agents");
    expect(gap).toHaveAttribute("data-reason", "lane-did-not-send");
    expect(gap).toHaveTextContent(LANE_4_STRADDLES);
  });

  it("says a lane-5 agent with no tool detail sent nothing", async () => {
    render(lane5, [agent({ tool_detail: null })]);
    await screen.findByTestId("agent-tools-row");
    expect(degraded("Tool detail for 1 of 1 agents")).toHaveAttribute(
      "data-reason",
      "lane-sent-nothing",
    );
  });

  it("marks a malformed breakdown unreadable instead of rendering part of it", async () => {
    render(lane5, [agent({ tool_detail: JSON.stringify({ read: "nope" }) })]);
    await screen.findByTestId("agent-tools-row");
    expect(degraded("Tool detail for 1 of 1 agents")).toHaveAttribute("data-reason", "unreadable");
  });

  it("marks a breakdown missing a key unreadable, never a zero count", async () => {
    const withoutGlob = JSON.parse(TOOL_DETAIL);
    delete withoutGlob.glob;
    render(lane5, [agent({ tool_detail: JSON.stringify(withoutGlob) })]);
    const row = await screen.findByTestId("agent-tools-row");
    expect(within(row).getAllByRole("cell")[3]).toHaveTextContent("—");
    expect(degraded("Tool detail for 1 of 1 agents")).toHaveAttribute("data-reason", "unreadable");
  });

  it("has nothing to break down on a round with no agent rows", async () => {
    render(lane5);
    expect(await screen.findByText(/no per-agent rows/)).toBeInTheDocument();
  });
});
