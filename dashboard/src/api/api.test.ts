import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, changesUrl, httpApi, isRoundAgentRow, isRoundAgentsResponse, laneEventsUrl, lookupRound, MAX_LIMIT_WITH_BLOBS, prsUrl, REQUIRED_ROUND_AGENT_KEYS, roundAgentsUrl, runsUrl, type RunsQuery } from "./client";
import { lookupPR } from "./queries";
import { CSV_COLUMNS, roundsToCsv } from "./csv";
import { parsePerModelUsage, parseRawResult, parseSubagentStats } from "./blobs";
import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import type { LaneEventRow, RoundAgentRow } from "./types";

const rows = makeRounds({ count: 64 });
const api = makeFixtureApi(rows);

describe("the read route is called only in the shapes worker/index.js accepts", () => {
  it("omits absent filters instead of sending empty ones", () => {
    expect(runsUrl({ limit: 1000 })).toBe("/api/runs?limit=1000");
    expect(runsUrl({ limit: 50, include: "blobs", repository: "a/b" })).toBe(
      "/api/runs?limit=50&include=blobs&repository=a%2Fb",
    );
    expect(runsUrl()).toBe("/api/runs");

    expect(laneEventsUrl({ limit: 500, repository: "a/b", since: "2026-08-01" })).toBe(
      "/api/lane-events?limit=500&repository=a%2Fb&since=2026-08-01",
    );
    expect(laneEventsUrl()).toBe("/api/lane-events");

    expect(changesUrl({ limit: 100, cursor: "2026-08-31|c1" })).toBe(
      "/api/changes?limit=100&cursor=2026-08-31%7Cc1",
    );
    expect(changesUrl()).toBe("/api/changes");

    expect(prsUrl({ limit: 1000, repository: "a/b", state: "open" })).toBe(
      "/api/prs?limit=1000&repository=a%2Fb&state=open",
    );
    expect(prsUrl()).toBe("/api/prs");
  });
});

describe("round lookup, given there is no by-id read route", () => {
  it("finds a round in one request when the timestamp bounds it", async () => {
    const target = rows[7];
    let calls = 0;
    const counted = {
      ...api,
      fetchRuns: (query = {}) => {
        calls += 1;
        return api.fetchRuns(query);
      },
    };
    const found = await lookupRound(counted, target.session_id, target.recorded_at);
    expect(found).toMatchObject({ found: true });
    expect(calls).toBe(1);
    if (found.found) {
      expect(found.row.session_id).toBe(target.session_id);
      expect(found.row.raw_result).toBeTruthy();
    }
  });

  it("falls back to a bounded scan without a timestamp", async () => {
    const target = rows[rows.length - 1];
    const found = await lookupRound(api, target.session_id);
    expect(found).toMatchObject({ found: true });
  });

  it("reports how far it looked when the round is not in the window", async () => {
    const missing = await lookupRound(api, "no-such-session");
    expect(missing).toEqual({ found: false, reason: "not-in-scan-window", scanned: rows.length });
  });
});

describe("the fixture table matches the Worker's paging contract", () => {
  it("caps a blob request at the Worker's blob limit", async () => {
    const page = await api.fetchRuns({ limit: 1000, include: "blobs" });
    expect(page.rows).toHaveLength(MAX_LIMIT_WITH_BLOBS);
    expect(page.next_cursor).toMatch(/\|/);
  });

  it("withholds the blob columns unless include=blobs is set", async () => {
    const page = await api.fetchRuns({ limit: 5 });
    expect(page.rows[0]).not.toHaveProperty("raw_result");
    expect(page.rows[0]).not.toHaveProperty("subagent_stats");
  });

  it("walks the cursor without repeating or skipping a round", async () => {
    const first = await api.fetchRuns({ limit: 20 });
    const second = await api.fetchRuns({ limit: 20, cursor: first.next_cursor! });
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.session_id));
    expect(ids.size).toBe(40);
  });

  it("pages lane events by cursor instead of returning page one twice (#104 finding 4)", async () => {
    const laneEvents: LaneEventRow[] = Array.from({ length: 40 }, (_, i) => ({
      run_id: i + 1,
      run_attempt: 1,
      recorded_at: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      repository: "prismalens/gh-workflows",
      reason: "no-token",
      pr_number: null,
      head_sha: null,
      run_url: null,
      rounds_used: null,
      lane_version: "v2.0.0",
    }));
    const laneApi = makeFixtureApi([], laneEvents);

    const first = await laneApi.fetchLaneEvents({ limit: 20 });
    expect(first.next_cursor).toMatch(/\|/);
    const second = await laneApi.fetchLaneEvents({ limit: 20, cursor: first.next_cursor! });

    expect(second.rows).not.toEqual(first.rows);
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.run_id));
    expect(ids.size).toBe(40);
  });
});

describe("blob parsing", () => {
  it("reads the per-model usage map and the denial tool counts", () => {
    const denied = rows.find((row) => (row.permission_denials ?? 0) > 0)!;
    expect(parsePerModelUsage(denied)).toBeTruthy();
    expect(parseRawResult(denied)?.denial_tools?.length).toBeGreaterThan(0);
  });

  it("returns null for a round whose lane sent no fan-out stats", () => {
    const verify = rows.find((row) => row.round_type === "verify")!;
    expect(parseSubagentStats(verify)).toBeNull();
  });

  it("reads the subagent_stats shape the design artboards show", () => {
    // The shape of a live subagent_stats blob as the Worker returns it.
    const stats = parseSubagentStats({
      ...rows[0],
      subagent_stats: JSON.stringify({
        spawned: 7,
        completed: 7,
        failed: 0,
        max_depth: 1,
        by_type: { "general-purpose": 7 },
        refused: { depth: 0, concurrency: 0, budget: 0 },
      }),
    });
    expect(stats?.lifecycle.map((e) => e.key)).toEqual([
      "spawned",
      "completed",
      "failed",
      "max_depth",
    ]);
    expect(stats?.groups.map((g) => g.key)).toEqual(["by_type", "refused"]);
    expect(stats?.unreadable).toBe(false);
  });

  it("renders any numeric field of subagent_stats without assuming its keys", () => {
    const stats = parseSubagentStats({
      ...rows[0],
      subagent_stats: JSON.stringify({ launched: 4, byModel: { opus: 2, sonnet: 2 }, note: "x" }),
    });
    expect(stats?.lifecycle).toEqual([{ key: "launched", value: 4 }]);
    expect(stats?.groups).toEqual([
      { key: "byModel", entries: [{ key: "opus", value: 2 }, { key: "sonnet", value: 2 }] },
    ]);
  });
});

describe("denial_tools reaches the panel usable or not at all", () => {
  const withRaw = (denial_tools: unknown) =>
    parseRawResult({ ...rows[0], raw_result: JSON.stringify({ type: "result", denial_tools }) });

  it("keeps a well-formed list", () => {
    expect(withRaw([{ tool: "Bash", count: 2 }])?.denial_tools).toEqual([
      { tool: "Bash", count: 2 },
    ]);
  });

  it("keeps an empty list, which means no tool was denied", () => {
    expect(withRaw([])?.denial_tools).toEqual([]);
  });

  it("degrades a non-array rather than throwing out of the panel", () => {
    expect(withRaw(5)?.denial_tools).toBeUndefined();
    expect(withRaw({ Bash: 1 })?.denial_tools).toBeUndefined();
  });

  it("degrades whole when any entry is unusable, rather than rendering the subset", () => {
    expect(withRaw([{ tool: "Bash", count: 1 }, { tool: null }])?.denial_tools).toBeUndefined();
    expect(withRaw([{ tool: {}, count: "x" }])?.denial_tools).toBeUndefined();
  });

  it("leaves an absent key absent", () => {
    expect(parseRawResult({ ...rows[0], raw_result: '{"type":"result"}' })?.denial_tools)
      .toBeUndefined();
  });
});

describe("a 200 of the wrong shape is malformed, not a TypeError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jsonBody = (body: unknown) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  };

  it("rejects a runs payload with no rows array", async () => {
    jsonBody({ next_cursor: null });
    await expect(httpApi.fetchRuns()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a runs payload whose rows are not objects", async () => {
    jsonBody({ rows: ["nope"], next_cursor: null });
    await expect(httpApi.fetchRuns()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a runs payload whose rows are missing specifically lane_version", async () => {
    // Row has all required fields except lane_version
    const row = {
      session_id: "s-1",
      recorded_at: "2026-08-31T00:00:00Z",
      repository: "prismalens/gh-workflows",
      pr_number: 1,
      pr_url: null,
      head_sha: "abc",
      run_id: 1,
      run_attempt: 1,
      run_url: null,
      round_type: "full",
      model: "claude-3-7-sonnet",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0.01,
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 1,
      permission_denials: 0,
      changed_files: 1,
      diff_lines: 10,
      // lane_version omitted
      verdict_kind: "clean",
      inline_count: 0,
      summary_count: 0,
      round_ordinal: 1,
      fallback_reason: null,
      range_base: null,
      range_head: null,
      model_source: null,
      job_conclusion: "success",
      pr_title: "Title",
      pr_author: "author",
      pr_state: "open",
      pr_base_ref: "main",
      pr_head_ref: "feat",
    };
    jsonBody({ rows: [row], next_cursor: null });
    await expect(httpApi.fetchRuns()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a summary payload with no row count", async () => {
    jsonBody({ repositories: [] });
    await expect(httpApi.fetchSummary()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a summary payload missing wave 2 breakdown fields or canary_last_seen_at", async () => {
    jsonBody({
      rows: 0,
      repositories: [],
      wall_clock_ms: { mean: null, p95: null },
      denials_per_run: null,
      cache_hit_rate: null,
      caching_multiplier: null,
      total_cost_usd: null,
      first_recorded_at: null,
      last_recorded_at: null,
      // Missing verdict_kinds, fallback_reasons, model_sources, canary_last_seen_at
    });
    await expect(httpApi.fetchSummary()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a lane-events payload whose rows are missing required fields", async () => {
    jsonBody({
      rows: [
        {
          run_id: 1,
          // Missing reason, repository, etc.
        },
      ],
      next_cursor: null,
    });
    await expect(httpApi.fetchLaneEvents()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a changes payload whose rows are missing required fields", async () => {
    jsonBody({
      rows: [
        {
          id: "c1",
          // Missing name, at, scope, etc.
        },
      ],
      next_cursor: null,
    });
    await expect(httpApi.fetchChanges()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a prs payload whose rows are missing required fields", async () => {
    jsonBody({
      rows: [
        {
          repository: "a/b",
          pr_number: 1,
          // Missing state, title, author, base_ref, head_ref, head_sha,
          // merged_at, closed_at, updated_at, source.
        },
      ],
      next_cursor: null,
    });
    await expect(httpApi.fetchPRs()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("accepts the shapes the Worker actually returns", async () => {
    jsonBody({ rows: [], next_cursor: null });
    await expect(httpApi.fetchRuns()).resolves.toMatchObject({ rows: [] });
    jsonBody({
      rows: 0,
      repositories: [],
      per_repository: [],
      wall_clock_ms: { mean: null, p95: null },
      denials_per_run: null,
      cache_hit_rate: null,
      caching_multiplier: null,
      total_cost_usd: null,
      first_recorded_at: null,
      last_recorded_at: null,
      verdict_kinds: {},
      fallback_reasons: {},
      model_sources: {},
      canary_last_seen_at: null,
    });
    await expect(httpApi.fetchSummary()).resolves.toMatchObject({ rows: 0, canary_last_seen_at: null });
    jsonBody({ rows: [], next_cursor: null });
    await expect(httpApi.fetchLaneEvents()).resolves.toMatchObject({ rows: [] });
    jsonBody({ rows: [], next_cursor: null });
    await expect(httpApi.fetchChanges()).resolves.toMatchObject({ rows: [] });
    jsonBody({ rows: [], next_cursor: null });
    await expect(httpApi.fetchPRs()).resolves.toMatchObject({ rows: [] });
  });
});

describe("CSV export", () => {
  it("writes the schema's columns in the schema's order", () => {
    const csv = roundsToCsv(rows.slice(0, 2));
    expect(csv.split("\r\n")[0]).toBe(CSV_COLUMNS.join(","));
    expect(csv.split("\r\n")).toHaveLength(3);
  });

  it("never emits a blob column, so an export cannot leak a raw record", () => {
    expect(CSV_COLUMNS).not.toContain("raw_result");
    expect(CSV_COLUMNS).not.toContain("subagent_stats");
    expect(CSV_COLUMNS).not.toContain("per_model_usage");
    expect(CSV_COLUMNS).not.toContain("verdict_text");
    expect(CSV_COLUMNS).not.toContain("comment_node_ids");
    expect(CSV_COLUMNS).not.toContain("config_resolution");
  });

  it("neutralises a cell a spreadsheet would run as a formula", () => {
    const csv = roundsToCsv([{ ...rows[0], repository: "=SUM(A1:A9)", model: 'a"b,c' }]);
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).toContain('"a""b,c"');
  });
});

describe("an error names the failure it actually was", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respond = (init: ResponseInit & { body?: string; type?: string }) => {
    // An opaqueredirect is status 0, which the Response constructor refuses, so
    // both fields are stamped on afterwards the way the platform reports them.
    const { status, type, body, ...rest } = init;
    const res = new Response(body ?? "", { ...rest, status: status === 0 ? 200 : status });
    if (status === 0) Object.defineProperty(res, "status", { value: 0 });
    if (type) Object.defineProperty(res, "type", { value: type });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
  };

  const kindOf = async (): Promise<ApiError> => {
    try {
      await httpApi.fetchSummary();
    } catch (error) {
      return error as ApiError;
    }
    throw new Error("expected fetchSummary to reject");
  };

  it("does not tell the operator to sign in again when the route 404s", async () => {
    respond({ status: 404, body: "<html>not found</html>", headers: { "content-type": "text/html" } });
    const error = await kindOf();
    expect(error.kind).toBe("http");
    expect(error.status).toBe(404);
  });

  it("does not tell the operator to sign in again on an edge 502", async () => {
    respond({ status: 502, body: "<html>bad gateway</html>", headers: { "content-type": "text/html" } });
    expect((await kindOf()).kind).toBe("http");
  });

  it("names a 403 from Access as unauthenticated", async () => {
    respond({
      status: 403,
      body: JSON.stringify({ error: "access_denied" }),
      headers: { "content-type": "application/json" },
    });
    const error = await kindOf();
    expect(error.kind).toBe("unauthenticated");
    expect(error.code).toBe("access_denied");
  });

  it("names a 503 from verifyAccess as unauthenticated, not a generic http error", async () => {
    respond({
      status: 503,
      body: JSON.stringify({ error: "access_unconfigured" }),
      headers: { "content-type": "application/json" },
    });
    const error = await kindOf();
    expect(error.kind).toBe("unauthenticated");
    expect(error.code).toBe("access_unconfigured");
  });

  it("carries the access_keys_unavailable code through from a 503", async () => {
    respond({
      status: 503,
      body: JSON.stringify({ error: "access_keys_unavailable" }),
      headers: { "content-type": "application/json" },
    });
    const error = await kindOf();
    expect(error.kind).toBe("unauthenticated");
    expect(error.code).toBe("access_keys_unavailable");
  });

  it("names an Access login page served 200 as unauthenticated", async () => {
    respond({ status: 200, body: "<html>sign in</html>", headers: { "content-type": "text/html" } });
    expect((await kindOf()).kind).toBe("unauthenticated");
  });

  it("names the Access redirect as unauthenticated rather than a network fault", async () => {
    // redirect: "manual" surfaces a cross-origin 302 as an opaqueredirect, which
    // following would instead have thrown a CORS TypeError into the network branch.
    respond({ status: 0, type: "opaqueredirect" });
    expect((await kindOf()).kind).toBe("unauthenticated");
  });

  it("keeps a genuine transport failure in the network branch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect((await kindOf()).kind).toBe("network");
  });

  it("requests without following redirects", async () => {
    respond({
      status: 200,
      body: JSON.stringify({
        rows: 0,
        repositories: [],
        per_repository: [],
        wall_clock_ms: { mean: null, p95: null },
        denials_per_run: null,
        cache_hit_rate: null,
        caching_multiplier: null,
        total_cost_usd: null,
        first_recorded_at: null,
        last_recorded_at: null,
        verdict_kinds: {},
        fallback_reasons: {},
        model_sources: {},
        canary_last_seen_at: null,
      }),
      headers: { "content-type": "application/json" },
    });
    await httpApi.fetchSummary();
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });
});

describe("lookupPR pages through cursors and validates PR numbers (findings 3943781301, 3943781319)", () => {
  it("rejects non-positive or non-integer PR numbers without fetching", async () => {
    let called = false;
    const dummyApi = {
      ...api,
      fetchRuns: async () => {
        called = true;
        return { rows: [], next_cursor: null };
      },
    };

    expect(await lookupPR(dummyApi, "prismalens/gh-workflows", 0)).toEqual({ found: false });
    expect(await lookupPR(dummyApi, "prismalens/gh-workflows", -5)).toEqual({ found: false });
    expect(await lookupPR(dummyApi, "prismalens/gh-workflows", Number.NaN)).toEqual({ found: false });
    expect(await lookupPR(dummyApi, "prismalens/gh-workflows", 1.5)).toEqual({ found: false });
    expect(called).toBe(false);
  });

  it("pages through repository rounds following next_cursor before returning matching PR rounds", async () => {
    const page1Row = {
      ...rows[0],
      session_id: "p1-round",
      pr_number: 999,
      recorded_at: "2026-08-31T10:00:00.000Z",
    };
    const page2Row = {
      ...rows[1],
      session_id: "p2-round",
      pr_number: 999,
      recorded_at: "2026-08-31T11:00:00.000Z",
    };
    const otherRow = {
      ...rows[2],
      session_id: "other-pr",
      pr_number: 888,
      recorded_at: "2026-08-31T12:00:00.000Z",
    };

    const cursorsSeen: (string | undefined)[] = [];
    const multiPageApi = {
      ...api,
      fetchRuns: async (query: RunsQuery = {}) => {
        cursorsSeen.push(query.cursor);
        if (!query.cursor) {
          return { rows: [otherRow, page1Row], next_cursor: "page-2-cursor" };
        }
        if (query.cursor === "page-2-cursor") {
          return { rows: [page2Row], next_cursor: null };
        }
        return { rows: [page1Row, page2Row], next_cursor: null };
      },
    };

    const result = await lookupPR(multiPageApi, "prismalens/gh-workflows", 999);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.rounds).toHaveLength(2);
      expect(result.rounds.map((r) => r.session_id)).toEqual(["p2-round", "p1-round"]);
    }
    expect(cursorsSeen).toContain(undefined);
    expect(cursorsSeen).toContain("page-2-cursor");
  });
});

describe("round agents API (#131, #89)", () => {
  it("formats round agents URL with session_id parameter", () => {
    expect(roundAgentsUrl("test-session-123")).toBe("/api/round-agents?session_id=test-session-123");
  });

  it("fetches round agents for a session from the fixture API", async () => {
    const mockAgent: RoundAgentRow = {
      session_id: "session-abc",
      agent_id: "agent-01",
      subagent_type: "general-purpose",
      spawn_depth: 1,
      status: "completed",
      model: "claude-sonnet-4-6",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
      duration_ms: 45000,
      tool_uses: 5,
      tool_uses_by_name: JSON.stringify({ ReadFile: 3, EditFile: 2 }),
      file_paths: JSON.stringify(["src/index.ts"]),
    };
    const agentApi = makeFixtureApi([], [], [], [mockAgent]);
    const response = await agentApi.fetchRoundAgents("session-abc");
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0].agent_id).toBe("agent-01");
    expect(response.rows[0].subagent_type).toBe("general-purpose");

    const emptyResponse = await agentApi.fetchRoundAgents("session-other");
    expect(emptyResponse.rows).toHaveLength(0);
  });

  it("validates all 14 declared RoundAgentRow fields and rejects invalid types (#131, finding 3944010369)", () => {
    const validRow = {
      session_id: "session-abc",
      agent_id: "agent-01",
      subagent_type: "general-purpose",
      spawn_depth: 1,
      status: "completed",
      model: "claude-sonnet-4-6",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
      duration_ms: 45000,
      tool_uses: 5,
      tool_uses_by_name: JSON.stringify({ ReadFile: 3 }),
      file_paths: JSON.stringify(["src/index.ts"]),
    };
    expect(isRoundAgentRow(validRow)).toBe(true);

    // All nullable fields set to null is valid
    const allNullsRow = {
      session_id: "session-abc",
      agent_id: "agent-01",
      subagent_type: null,
      spawn_depth: null,
      status: null,
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      duration_ms: null,
      tool_uses: null,
      tool_uses_by_name: null,
      file_paths: null,
    };
    expect(isRoundAgentRow(allNullsRow)).toBe(true);

    // Missing any required key is invalid
    for (const key of REQUIRED_ROUND_AGENT_KEYS) {
      const missingKeyRow: Record<string, unknown> = { ...validRow };
      delete missingKeyRow[key];
      expect(isRoundAgentRow(missingKeyRow)).toBe(false);
    }

    // Wrong type for string field is invalid
    expect(isRoundAgentRow({ ...validRow, session_id: 123 })).toBe(false);
    expect(isRoundAgentRow({ ...validRow, subagent_type: 123 })).toBe(false);

    // Wrong type for number field is invalid
    expect(isRoundAgentRow({ ...validRow, input_tokens: "1000" })).toBe(false);
    expect(isRoundAgentRow({ ...validRow, duration_ms: "45000" })).toBe(false);
  });

  it("requires next_cursor to be present as string or null in RoundAgentsResponse (#131, finding 3944010369)", () => {
    const validRow = {
      session_id: "session-abc",
      agent_id: "agent-01",
      subagent_type: null,
      spawn_depth: null,
      status: null,
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      duration_ms: null,
      tool_uses: null,
      tool_uses_by_name: null,
      file_paths: null,
    };

    // next_cursor: null is valid
    expect(isRoundAgentsResponse({ rows: [validRow], next_cursor: null })).toBe(true);

    // next_cursor: string is valid
    expect(isRoundAgentsResponse({ rows: [validRow], next_cursor: "cursor-123" })).toBe(true);

    // Missing next_cursor is invalid
    expect(isRoundAgentsResponse({ rows: [validRow] })).toBe(false);

    // next_cursor: undefined is invalid
    expect(isRoundAgentsResponse({ rows: [validRow], next_cursor: undefined })).toBe(false);

    // next_cursor: number is invalid
    expect(isRoundAgentsResponse({ rows: [validRow], next_cursor: 123 })).toBe(false);
  });
});
