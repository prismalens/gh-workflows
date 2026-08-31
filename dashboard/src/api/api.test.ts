import { describe, expect, it } from "vitest";

import { lookupRound, MAX_LIMIT_WITH_BLOBS, runsUrl } from "./client";
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
  });

  it("neutralises a cell a spreadsheet would run as a formula", () => {
    const csv = roundsToCsv([{ ...rows[0], repository: "=SUM(A1:A9)", model: 'a"b,c' }]);
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).toContain('"a""b,c"');
  });
});
