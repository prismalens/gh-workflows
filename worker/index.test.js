import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

function createFakeDb(options = {}) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (options.shouldThrow) {
                throw new Error("D1 run error");
              }
              queries.push({ sql, args });
              return { success: true };
            },
            async first() {
              queries.push({ sql, args });
              return null;
            },
            async all() {
              queries.push({ sql, args });
              return { results: [] };
            },
          };
        },
        async first() {
          queries.push({ sql, args: [] });
          return null;
        },
        async all() {
          queries.push({ sql, args: [] });
          return { results: [] };
        },
      };
    },
  };
}

function makeRequest(path, { method = "POST", headers = {}, body } = {}) {
  const defaultHeaders = {
    "content-type": "application/json",
  };
  const finalHeaders = { ...defaultHeaders, ...headers };
  const init = {
    method,
    headers: finalHeaders,
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`https://review-telemetry.sfun.cloud${path}`, init);
}

const VALID_TOKEN = "secret-token-123";

describe("Worker telemetry ingest", () => {
  describe("Authentication", () => {
    it("returns 401 when authorization header is missing", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        body: { session_id: "s-1", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401);
      assert.equal(db.queries.length, 0);
    });

    it("returns 401 when token is wrong for usage_record", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: "Bearer wrong-token" },
        body: { session_id: "s-1", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401);
      assert.equal(db.queries.length, 0);
    });

    it("returns 401 when token is wrong for lane_event", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: "Bearer wrong-token" },
        body: {
          event_kind: "lane_event",
          repository: "prismalens/gh-workflows",
          reason: "no-token",
          run_id: 100,
          run_attempt: 1,
        },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401);
      assert.equal(db.queries.length, 0);
    });

    it("returns 401 when token is wrong for canary", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: "Bearer wrong-token" },
        body: { event_kind: "canary" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401);
      assert.equal(db.queries.length, 0);
    });

    it("returns 401 when env token is not configured", async () => {
      const db = createFakeDb();
      const env = { DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { session_id: "s-1", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401);
    });
  });

  describe("Usage record ingest (v1 and v2)", () => {
    it("inserts a v1 payload with no new fields and binds NULL for every new column", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const v1Payload = {
        session_id: "session-v1-001",
        recorded_at: "2026-08-31T12:00:00.000Z",
        repository: "prismalens/gh-workflows",
        pr_number: 42,
        pr_url: "https://github.com/prismalens/gh-workflows/pull/42",
        head_sha: "abcdef1234567890abcdef1234567890abcdef12",
        run_id: 987654,
        run_attempt: 1,
        run_url: "https://github.com/prismalens/gh-workflows/actions/runs/987654",
        round_type: "review",
        model: "claude-3-7-sonnet",
        input_tokens: 1500,
        output_tokens: 400,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
        total_cost_usd: 0.045,
        duration_ms: 5400,
        duration_api_ms: 4800,
        num_turns: 3,
        permission_denials: 0,
        changed_files: 2,
        diff_lines: 45,
        per_model_usage: { "claude-3-7-sonnet": { input: 1500, output: 400 } },
        subagent_stats: null,
        raw_result: "OK",
      };

      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: v1Payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);

      const query = db.queries[0];
      assert.match(query.sql, /INSERT INTO usage_records/);
      assert.equal(query.args.length, 43);

      // Verify v1 fields
      assert.equal(query.args[0], "session-v1-001");
      assert.equal(query.args[1], "2026-08-31T12:00:00.000Z");
      assert.equal(query.args[2], "prismalens/gh-workflows");
      assert.equal(query.args[3], 42);
      assert.equal(query.args[4], "https://github.com/prismalens/gh-workflows/pull/42");
      assert.equal(query.args[5], "abcdef1234567890abcdef1234567890abcdef12");
      assert.equal(query.args[6], 987654);
      assert.equal(query.args[7], 1);
      assert.equal(query.args[8], "https://github.com/prismalens/gh-workflows/actions/runs/987654");
      assert.equal(query.args[9], "review");
      assert.equal(query.args[10], "claude-3-7-sonnet");
      assert.equal(query.args[11], 1500);
      assert.equal(query.args[12], 400);
      assert.equal(query.args[13], 800);
      assert.equal(query.args[14], 200);
      assert.equal(query.args[15], 0.045);
      assert.equal(query.args[16], 5400);
      assert.equal(query.args[17], 4800);
      assert.equal(query.args[18], 3);
      assert.equal(query.args[19], 0);
      assert.equal(query.args[20], 2);
      assert.equal(query.args[21], 45);
      assert.equal(query.args[22], JSON.stringify(v1Payload.per_model_usage));
      assert.equal(query.args[23], null);
      assert.equal(query.args[24], "OK");

      // Verify every new column (index 25 to 42) is null
      for (let i = 25; i < 43; i++) {
        assert.equal(query.args[i], null, `Expected index ${i} to be null, got ${query.args[i]}`);
      }
    });

    it("inserts a full v2 payload and binds every new column with given values", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const v2Payload = {
        event_kind: "usage_record",
        session_id: "session-v2-002",
        recorded_at: "2026-08-31T15:30:00.000Z",
        repository: "prismalens/gh-workflows",
        pr_number: 101,
        pr_url: "https://github.com/prismalens/gh-workflows/pull/101",
        head_sha: "1111222233334444555566667777888899990000",
        run_id: 112233,
        run_attempt: 2,
        run_url: "https://github.com/prismalens/gh-workflows/actions/runs/112233",
        round_type: "incremental",
        model: "claude-3-7-sonnet",
        input_tokens: 3000,
        output_tokens: 800,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 400,
        total_cost_usd: 0.08,
        duration_ms: 12000,
        duration_api_ms: 10500,
        num_turns: 5,
        permission_denials: 1,
        changed_files: 4,
        diff_lines: 120,
        per_model_usage: { "claude-3-7-sonnet": { input: 3000, output: 800 } },
        subagent_stats: { researcher: { calls: 2 } },
        raw_result: "success",
        // Wave 2 additions
        lane_version: "v2.1.0",
        verdict_kind: "clean",
        verdict_text: "No security or correctness findings",
        inline_count: 0,
        summary_count: 1,
        comment_node_ids: ["MDEyOklzc3VlQ29tbWVudDE=", "MDEyOklzc3VlQ29tbWVudDI="],
        fallback_reason: "none",
        range_base: "aaa111",
        range_head: "bbb222",
        model_source: "workflow-default",
        config_resolution: { review: "repo", model: "workflow" },
        job_conclusion: "success",
        round_ordinal: 3,
        pr_title: "feat: implement wave 2 telemetry ingest",
        pr_author: "developer-1",
        pr_state: "open",
        pr_base_ref: "main",
        pr_head_ref: "feat/wave2",
      };

      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: v2Payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);

      const query = db.queries[0];
      assert.equal(query.args[25], "v2.1.0");
      assert.equal(query.args[26], "clean");
      assert.equal(query.args[27], "No security or correctness findings");
      assert.equal(query.args[28], 0);
      assert.equal(query.args[29], 1);
      assert.equal(query.args[30], JSON.stringify(v2Payload.comment_node_ids));
      assert.equal(query.args[31], "none");
      assert.equal(query.args[32], "aaa111");
      assert.equal(query.args[33], "bbb222");
      assert.equal(query.args[34], "workflow-default");
      assert.equal(query.args[35], JSON.stringify(v2Payload.config_resolution));
      assert.equal(query.args[36], "success");
      assert.equal(query.args[37], 3);
      assert.equal(query.args[38], "feat: implement wave 2 telemetry ingest");
      assert.equal(query.args[39], "developer-1");
      assert.equal(query.args[40], "open");
      assert.equal(query.args[41], "main");
      assert.equal(query.args[42], "feat/wave2");
    });

    it("works when posting to root path '/' as alias to /ingest", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { session_id: "s-root-1", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);
    });

    it("ignores unknown extra fields rather than rejecting", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const payload = {
        session_id: "session-extra-003",
        repository: "prismalens/gh-workflows",
        unknown_future_field: "some value",
        another_custom_object: { foo: "bar" },
        an_array_field: [1, 2, 3],
      };

      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);
      assert.equal(db.queries[0].args[0], "session-extra-003");
    });

    it("truncates 600-character pr_title to 512 characters", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const longTitle = "T".repeat(600);
      const payload = {
        session_id: "session-long-title",
        repository: "prismalens/gh-workflows",
        pr_title: longTitle,
      };

      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);

      const boundTitle = db.queries[0].args[38];
      assert.equal(boundTitle.length, 512);
      assert.equal(boundTitle, "T".repeat(512));
    });

    it("truncates pr_author, pr_base_ref, and pr_head_ref to 512 characters", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const longString = "A".repeat(600);
      const payload = {
        session_id: "session-long-refs",
        repository: "prismalens/gh-workflows",
        pr_author: longString,
        pr_base_ref: longString,
        pr_head_ref: longString,
      };

      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);

      const query = db.queries[0];
      assert.equal(query.args[39], "A".repeat(512));
      assert.equal(query.args[41], "A".repeat(512));
      assert.equal(query.args[42], "A".repeat(512));
    });

    it("returns 400 when usage record session_id or repository is missing", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      const req1 = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { repository: "prismalens/gh-workflows" },
      });
      const res1 = await worker.fetch(req1, env);
      assert.equal(res1.status, 400);

      const req2 = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { session_id: "s-1" },
      });
      const res2 = await worker.fetch(req2, env);
      assert.equal(res2.status, 400);
    });

    it("returns 400 when numeric or string fields have invalid types", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      const badNumericReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-bad-num",
          repository: "prismalens/gh-workflows",
          round_ordinal: "not-a-number",
        },
      });
      const badNumRes = await worker.fetch(badNumericReq, env);
      assert.equal(badNumRes.status, 400);

      const badStringReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-bad-str",
          repository: "prismalens/gh-workflows",
          verdict_kind: 12345,
        },
      });
      const badStrRes = await worker.fetch(badStringReq, env);
      assert.equal(badStrRes.status, 400);
    });

    it("returns 400 when comment_node_ids is not an array (nor a string that parses to one)", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      const notJsonReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-bad-comment-ids-1",
          repository: "prismalens/gh-workflows",
          comment_node_ids: "not-json",
        },
      });
      assert.equal((await worker.fetch(notJsonReq, env)).status, 400);

      const wrongShapeReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-bad-comment-ids-2",
          repository: "prismalens/gh-workflows",
          comment_node_ids: { not: "an array" },
        },
      });
      assert.equal((await worker.fetch(wrongShapeReq, env)).status, 400);
      assert.equal(db.queries.length, 0);
    });

    it("returns 400 when config_resolution is not an object (nor a string that parses to one)", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      const notJsonReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-bad-config-1",
          repository: "prismalens/gh-workflows",
          config_resolution: "not-json",
        },
      });
      assert.equal((await worker.fetch(notJsonReq, env)).status, 400);

      const wrongShapeReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-bad-config-2",
          repository: "prismalens/gh-workflows",
          config_resolution: ["not", "an", "object"],
        },
      });
      assert.equal((await worker.fetch(wrongShapeReq, env)).status, 400);
      assert.equal(db.queries.length, 0);
    });

    it("accepts a JSON-string comment_node_ids array and config_resolution object, and stores them", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const payload = {
        session_id: "s-good-json-string-fields",
        repository: "prismalens/gh-workflows",
        comment_node_ids: JSON.stringify(["MDEyOklzc3VlQ29tbWVudDE="]),
        config_resolution: JSON.stringify({ review: "repo" }),
      };

      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);

      const query = db.queries[0];
      assert.equal(query.args[30], payload.comment_node_ids);
      assert.equal(query.args[35], payload.config_resolution);
    });
  });

  describe("Lane events ingest (event_kind: 'lane_event')", () => {
    it("inserts into lane_events with valid reason and required fields", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const laneEventPayload = {
        event_kind: "lane_event",
        run_id: 123456,
        run_attempt: 1,
        recorded_at: "2026-08-31T14:20:00.000Z",
        repository: "prismalens/gh-workflows",
        reason: "auto-paused",
        pr_number: 88,
        head_sha: "aabbccddeeff00112233445566778899aabbccdd",
        run_url: "https://github.com/prismalens/gh-workflows/actions/runs/123456",
        rounds_used: 3,
        lane_version: "v2.0.0",
      };

      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: laneEventPayload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);

      const query = db.queries[0];
      assert.match(query.sql, /INSERT INTO lane_events/);
      assert.match(query.sql, /ON CONFLICT\(run_id, run_attempt\) DO NOTHING/);
      assert.deepEqual(query.args, [
        123456,
        1,
        "2026-08-31T14:20:00.000Z",
        "prismalens/gh-workflows",
        "auto-paused",
        88,
        "aabbccddeeff00112233445566778899aabbccdd",
        "https://github.com/prismalens/gh-workflows/actions/runs/123456",
        3,
        "v2.0.0",
      ]);
    });

    it("supports all four valid reasons: no-token, auto-paused, fork-head, skip-author", async () => {
      const reasons = ["no-token", "auto-paused", "fork-head", "skip-author"];
      for (const reason of reasons) {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/ingest", {
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            event_kind: "lane_event",
            run_id: 200,
            run_attempt: 1,
            repository: "prismalens/gh-workflows",
            reason,
          },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 204, `Expected 204 for reason: ${reason}`);
        assert.equal(db.queries[0].args[4], reason);
      }
    });

    it("returns 400 when reason is invalid", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          event_kind: "lane_event",
          run_id: 123456,
          run_attempt: 1,
          repository: "prismalens/gh-workflows",
          reason: "unknown-reason",
        },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 400);
      assert.equal(db.queries.length, 0);
    });

    it("returns 400 when run_id is missing or not a finite number", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      const reqMissing = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          event_kind: "lane_event",
          run_attempt: 1,
          repository: "prismalens/gh-workflows",
          reason: "no-token",
        },
      });
      const resMissing = await worker.fetch(reqMissing, env);
      assert.equal(resMissing.status, 400);

      const reqNaN = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          event_kind: "lane_event",
          run_id: "not-a-number",
          run_attempt: 1,
          repository: "prismalens/gh-workflows",
          reason: "no-token",
        },
      });
      const resNaN = await worker.fetch(reqNaN, env);
      assert.equal(resNaN.status, 400);
    });

    it("returns 400 when run_attempt or repository is missing", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      const reqMissingAttempt = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          event_kind: "lane_event",
          run_id: 123456,
          repository: "prismalens/gh-workflows",
          reason: "no-token",
        },
      });
      const resMissingAttempt = await worker.fetch(reqMissingAttempt, env);
      assert.equal(resMissingAttempt.status, 400);

      const reqMissingRepo = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          event_kind: "lane_event",
          run_id: 123456,
          run_attempt: 1,
          reason: "no-token",
        },
      });
      const resMissingRepo = await worker.fetch(reqMissingRepo, env);
      assert.equal(resMissingRepo.status, 400);
    });
  });

  describe("Canary pings ingest (event_kind: 'canary')", () => {
    it("performs a real D1 write and returns 204", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          event_kind: "canary",
          run_url: "https://github.com/prismalens/gh-workflows/actions/runs/canary-1",
          lane_version: "v2.0.0",
          last_seen_at: "2026-08-31T18:00:00.000Z",
        },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);

      const query = db.queries[0];
      assert.match(query.sql, /INSERT INTO canary_pings/);
      assert.match(query.sql, /ON CONFLICT\(id\) DO UPDATE SET/);
      assert.equal(query.args[0], "canary");
      assert.equal(query.args[1], "2026-08-31T18:00:00.000Z");
      assert.equal(query.args[2], "https://github.com/prismalens/gh-workflows/actions/runs/canary-1");
      assert.equal(query.args[3], "v2.0.0");
    });

    it("upserts with default timestamp when last_seen_at / recorded_at is omitted", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { event_kind: "canary" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);

      const query = db.queries[0];
      assert.equal(query.args[0], "canary");
      assert.ok(typeof query.args[1] === "string");
      assert.equal(query.args[2], null);
      assert.equal(query.args[3], null);
    });
  });

  describe("Discriminator & general error handling", () => {
    it("returns 400 for unknown event_kind", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { event_kind: "invalid_kind" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 400);
      assert.equal(db.queries.length, 0);
    });

    it("returns 400 for non-JSON or invalid body", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: "not json at all",
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 400);
    });

    it("returns 500 when D1 query fails", async () => {
      const db = createFakeDb({ shouldThrow: true });
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { session_id: "s-err", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 500);
    });

    it("returns 404 for unmapped paths", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/non-existent-route", { method: "POST" });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 404);
    });
  });
});
