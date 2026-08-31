import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, httpApi, laneEventsUrl, lookupRound, MAX_LIMIT_WITH_BLOBS, runsUrl } from "./client";
import { CSV_COLUMNS, roundsToCsv } from "./csv";
import { parsePerModelUsage, parseRawResult, parseSubagentStats } from "./blobs";
import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";

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
    // From docs/design/canvas/RoundDetail.dc.html on the #82 branch.
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

  it("accepts the shapes the Worker actually returns", async () => {
    jsonBody({ rows: [], next_cursor: null });
    await expect(httpApi.fetchRuns()).resolves.toMatchObject({ rows: [] });
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
      verdict_kinds: {},
      fallback_reasons: {},
      model_sources: {},
      canary_last_seen_at: null,
    });
    await expect(httpApi.fetchSummary()).resolves.toMatchObject({ rows: 0, canary_last_seen_at: null });
    jsonBody({ rows: [], next_cursor: null });
    await expect(httpApi.fetchLaneEvents()).resolves.toMatchObject({ rows: [] });
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
      body: JSON.stringify({ error: "forbidden" }),
      headers: { "content-type": "application/json" },
    });
    expect((await kindOf()).kind).toBe("unauthenticated");
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
