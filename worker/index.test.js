import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { computeVariantKey } from "./index.js";

function createFakeDb(options = {}) {
  const queries = [];
  const handleQuery = (sql, args) => {
    queries.push({ sql, args });
    if (options.shouldThrow) {
      throw new Error("D1 query error");
    }
    if (options.handler) {
      return options.handler(sql, args);
    }
    return null;
  };
  return {
    queries,
    async batch(statements) {
      if (options.shouldThrow) {
        throw new Error("D1 batch error");
      }
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
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
              const res = handleQuery(sql, args);
              return res?.first !== undefined ? res.first : (res ?? null);
            },
            async all() {
              const res = handleQuery(sql, args);
              return res?.results ? res : { results: Array.isArray(res) ? res : [] };
            },
          };
        },
        async first() {
          const res = handleQuery(sql, []);
          return res?.first !== undefined ? res.first : (res ?? null);
        },
        async all() {
          const res = handleQuery(sql, []);
          return res?.results ? res : { results: Array.isArray(res) ? res : [] };
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

    it("returns 401 for a wrong token the same length as the real one", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const wrongSameLength = "x".repeat(VALID_TOKEN.length);
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${wrongSameLength}` },
        body: { session_id: "s-1", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401);
      assert.equal(db.queries.length, 0);
    });
  });

  describe("Rate limiting (#60)", () => {
    it("returns 429 when the INGEST_RATE_LIMITER binding refuses the request", async () => {
      const db = createFakeDb();
      const limiter = { limit: async () => ({ success: false }) };
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db, INGEST_RATE_LIMITER: limiter };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { session_id: "s-1", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 429);
      assert.equal(db.queries.length, 0);
    });

    it("keys the limiter on the client IP", async () => {
      const db = createFakeDb();
      const seenKeys = [];
      const limiter = {
        limit: async ({ key }) => {
          seenKeys.push(key);
          return { success: true };
        },
      };
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db, INGEST_RATE_LIMITER: limiter };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}`, "cf-connecting-ip": "203.0.113.9" },
        body: { session_id: "s-1", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.deepEqual(seenKeys, ["203.0.113.9"]);
    });

    it("proceeds when no rate limiter binding is configured", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { session_id: "s-1", repository: "prismalens/gh-workflows" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
    });
  });

  describe("Request size limits (#60)", () => {
    it("returns 413 for a body over the cap announced via content-length", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const oversizedBody = "x".repeat(1_000_001);
      const req = makeRequest("/ingest", {
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
          "content-length": String(oversizedBody.length),
        },
        body: oversizedBody,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 413);
      assert.equal(db.queries.length, 0);
    });

    it("returns 413 for a body over the cap with no content-length header", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const oversizedBody = JSON.stringify({
        session_id: "s-1",
        repository: "prismalens/gh-workflows",
        raw_result: "x".repeat(1_000_001),
      });
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: oversizedBody,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 413);
      assert.equal(db.queries.length, 0);
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
      assert.equal(query.args.length, 51);

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

      // Verify every wave 2 and variant identity column (index 25 to 46) is null: this
      // payload sets none of them.
      for (let i = 25; i < 47; i++) {
        assert.equal(query.args[i], null, `Expected index ${i} to be null, got ${query.args[i]}`);
      }

      // variant_key (index 47) is still computed from the fields v1 DOES carry
      // (model, round_type), never left null just because the four new fields are absent.
      const expectedVariantKey = await computeVariantKey(null, "claude-3-7-sonnet", null, null, "review");
      assert.equal(query.args[47], expectedVariantKey);
      assert.match(query.args[47], /^[0-9a-f]{64}$/);

      // reviewable_lines (49) and size_override (50) are the #105 manifest fields;
      // a v1 payload predates them and binds NULL for both.
      assert.equal(query.args[49], null);
      assert.equal(query.args[50], null);
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
        // Variant identity additions (#47)
        prompt_hash: "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44",
        action_version: "a874e9ecd7bb36efdad65429c6b35815f5a08f10",
        config_hash: "11223344556677889900aabbccddeeff11223344556677889900aabbccddee",
        variant: "canary-prompt-v2",
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
      assert.equal(query.args[43], v2Payload.prompt_hash);
      assert.equal(query.args[44], v2Payload.action_version);
      assert.equal(query.args[45], v2Payload.config_hash);
      assert.equal(query.args[46], v2Payload.variant);

      const expectedVariantKey = await computeVariantKey(
        v2Payload.prompt_hash,
        v2Payload.model,
        v2Payload.action_version,
        v2Payload.config_hash,
        v2Payload.round_type
      );
      assert.equal(query.args[47], expectedVariantKey);
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

  describe("Per-agent telemetry ingest (round_agents) (#93)", () => {
    it("a payload with no agents key still records the round, unchanged", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const payload = {
        session_id: "s-no-agents-1",
        repository: "prismalens/gh-workflows",
        model: "claude-3-5-sonnet",
      };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);
      assert.match(db.queries[0].sql, /INSERT INTO usage_records/);
      assert.equal(db.queries[0].args[0], "s-no-agents-1");
    });

    it("a payload with two agents records two rows joined to the round by session_id", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const payload = {
        session_id: "s-with-agents-1",
        repository: "prismalens/gh-workflows",
        agents: [
          {
            agent_id: "agent-alpha",
            subagent_type: "worker",
            spawn_depth: 1,
            status: "completed",
            model: "claude-3-5-sonnet",
            input_tokens: 1500,
            output_tokens: 300,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
            duration_ms: 12000,
            tool_uses: 5,
            tool_uses_by_name: { ReadFile: 3, RunCommand: 2 },
            file_paths: ["src/index.js", "src/util.js"],
          },
          {
            agent_id: "agent-beta",
            subagent_type: "reviewer",
            spawn_depth: 2,
            status: "completed",
            model: "claude-3-5-haiku",
            input_tokens: 800,
            output_tokens: 150,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 20,
            duration_ms: 5000,
            tool_uses: 2,
            tool_uses_by_name: { ReadFile: 2 },
            file_paths: ["src/index.js"],
          },
        ],
      };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 3);
      assert.match(db.queries[0].sql, /INSERT INTO usage_records/);
      assert.equal(db.queries[0].args[0], "s-with-agents-1");

      assert.match(db.queries[1].sql, /INSERT INTO round_agents/);
      assert.equal(db.queries[1].args[0], "s-with-agents-1");
      assert.equal(db.queries[1].args[1], "agent-alpha");
      assert.equal(db.queries[1].args[2], "worker");
      assert.equal(db.queries[1].args[3], 1);
      assert.equal(db.queries[1].args[4], "completed");
      assert.equal(db.queries[1].args[5], "claude-3-5-sonnet");
      assert.equal(db.queries[1].args[6], 1500);
      assert.equal(db.queries[1].args[7], 300);
      assert.equal(db.queries[1].args[8], 100);
      assert.equal(db.queries[1].args[9], 50);
      assert.equal(db.queries[1].args[10], 12000);
      assert.equal(db.queries[1].args[11], 5);
      assert.equal(db.queries[1].args[12], JSON.stringify({ ReadFile: 3, RunCommand: 2 }));
      assert.equal(db.queries[1].args[13], JSON.stringify(["src/index.js", "src/util.js"]));

      assert.match(db.queries[2].sql, /INSERT INTO round_agents/);
      assert.equal(db.queries[2].args[0], "s-with-agents-1");
      assert.equal(db.queries[2].args[1], "agent-beta");
      assert.equal(db.queries[2].args[2], "reviewer");
      assert.equal(db.queries[2].args[3], 2);
    });

    it("a session_id inside an agent entry is ignored in favour of the top-level one", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const payload = {
        session_id: "canonical-session-id",
        repository: "prismalens/gh-workflows",
        agents: [
          {
            session_id: "spoofed-session-id",
            agent_id: "agent-1",
            subagent_type: "worker",
          },
        ],
      };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 2);
      assert.equal(db.queries[1].args[0], "canonical-session-id");
    });

    it("65 entries is rejected, 64 is accepted", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      const agents65 = Array.from({ length: 65 }, (_, i) => ({
        agent_id: `agent-${i}`,
      }));
      const badReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-65",
          repository: "prismalens/gh-workflows",
          agents: agents65,
        },
      });
      const badRes = await worker.fetch(badReq, env);
      assert.equal(badRes.status, 400);
      assert.equal(db.queries.length, 0);

      const agents64 = Array.from({ length: 64 }, (_, i) => ({
        agent_id: `agent-${i}`,
      }));
      const goodReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-64",
          repository: "prismalens/gh-workflows",
          agents: agents64,
        },
      });
      const goodRes = await worker.fetch(goodReq, env);
      assert.equal(goodRes.status, 204);
      assert.equal(db.queries.length, 65);
    });

    it("an agent_id over 512 characters is rejected rather than truncated into a collision", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      // Same first 512 characters, different tails. Truncating the primary key would
      // make the second silently overwrite the first.
      const prefix = "a".repeat(512);
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-long-agent-id",
          repository: "prismalens/gh-workflows",
          agents: [{ agent_id: `${prefix}-one` }, { agent_id: `${prefix}-two` }],
        },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /index 0.*512/);
      assert.equal(db.queries.length, 0);

      // Exactly at the limit is still accepted.
      const okDb = createFakeDb();
      const okReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-agent-id-at-limit",
          repository: "prismalens/gh-workflows",
          agents: [{ agent_id: prefix }],
        },
      });
      const okRes = await worker.fetch(okReq, { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: okDb });
      assert.equal(okRes.status, 204);
      assert.equal(okDb.queries[1].args[1], prefix);
    });

    it("a non-array agents, a non-object entry, and a missing agent_id are each rejected with the index named", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

      // non-array agents
      const nonArrayReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-bad-agents-array",
          repository: "prismalens/gh-workflows",
          agents: "not-an-array",
        },
      });
      const nonArrayRes = await worker.fetch(nonArrayReq, env);
      assert.equal(nonArrayRes.status, 400);
      assert.equal(db.queries.length, 0);

      // non-object entry at index 1
      const nonObjectReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-bad-agent-entry",
          repository: "prismalens/gh-workflows",
          agents: [{ agent_id: "agent-0" }, "not-an-object", { agent_id: "agent-2" }],
        },
      });
      const nonObjectRes = await worker.fetch(nonObjectReq, env);
      assert.equal(nonObjectRes.status, 400);
      const nonObjectBody = await nonObjectRes.json();
      assert.match(nonObjectBody.error, /index 1/);
      assert.equal(db.queries.length, 0);

      // missing agent_id at index 2
      const missingIdReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-missing-agent-id",
          repository: "prismalens/gh-workflows",
          agents: [{ agent_id: "agent-0" }, { agent_id: "agent-1" }, { subagent_type: "worker" }],
        },
      });
      const missingIdRes = await worker.fetch(missingIdReq, env);
      assert.equal(missingIdRes.status, 400);
      const missingIdBody = await missingIdRes.json();
      assert.match(missingIdBody.error, /index 2/);
      assert.equal(db.queries.length, 0);

      // empty agent_id at index 0
      const emptyIdReq = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          session_id: "s-empty-agent-id",
          repository: "prismalens/gh-workflows",
          agents: [{ agent_id: "" }],
        },
      });
      const emptyIdRes = await worker.fetch(emptyIdReq, env);
      assert.equal(emptyIdRes.status, 400);
      const emptyIdBody = await emptyIdRes.json();
      assert.match(emptyIdBody.error, /index 0/);
      assert.equal(db.queries.length, 0);
    });

    it("integer fields that are not integers become null and string fields are truncated", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const longStatus = "x".repeat(600);
      const payload = {
        session_id: "s-types",
        repository: "prismalens/gh-workflows",
        agents: [
          {
            agent_id: "agent-type-check",
            status: longStatus,
            spawn_depth: "not-an-int",
            input_tokens: 12.34,
            output_tokens: "1000",
            duration_ms: NaN,
            tool_uses: null,
          },
        ],
      };
      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 2);
      const agentQuery = db.queries[1];
      assert.equal(agentQuery.args[4].length, 512);
      assert.equal(agentQuery.args[3], null);
      assert.equal(agentQuery.args[6], null);
      assert.equal(agentQuery.args[7], null);
      assert.equal(agentQuery.args[10], null);
      assert.equal(agentQuery.args[11], null);
    });

    it("re-ingesting the same (session_id, agent_id) replaces rather than duplicates", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const payload1 = {
        session_id: "s-reingest",
        repository: "prismalens/gh-workflows",
        agents: [
          {
            agent_id: "agent-1",
            status: "running",
            input_tokens: 100,
          },
        ],
      };
      const req1 = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload1,
      });
      const res1 = await worker.fetch(req1, env);
      assert.equal(res1.status, 204);

      const query1 = db.queries[1];
      assert.match(query1.sql, /INSERT INTO round_agents/);
      assert.match(query1.sql, /ON CONFLICT\s*\(session_id,\s*agent_id\)\s+DO\s+UPDATE\s+SET/);
      assert.match(query1.sql, /status\s*=\s*excluded\.status/);
      assert.match(query1.sql, /input_tokens\s*=\s*excluded\.input_tokens/);

      const payload2 = {
        session_id: "s-reingest",
        repository: "prismalens/gh-workflows",
        agents: [
          {
            agent_id: "agent-1",
            status: "completed",
            input_tokens: 500,
          },
        ],
      };
      const req2 = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: payload2,
      });
      const res2 = await worker.fetch(req2, env);
      assert.equal(res2.status, 204);
      assert.equal(db.queries.length, 4);
      assert.equal(db.queries[3].args[4], "completed");
      assert.equal(db.queries[3].args[6], 500);
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
        // reviewable_lines / max_reviewable_lines (#105): null on a payload that
        // predates the review manifest cap.
        null,
        null,
      ]);
    });

    it("inserts a refused-size lane event with reviewable_lines and max_reviewable_lines", async () => {
      const db = createFakeDb();
      const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
      const laneEventPayload = {
        event_kind: "lane_event",
        run_id: 654321,
        run_attempt: 1,
        recorded_at: "2026-09-07T09:00:00.000Z",
        repository: "prismalens/gh-workflows",
        reason: "refused-size",
        pr_number: 105,
        head_sha: "00112233445566778899aabbccddeeff0011223",
        run_url: "https://github.com/prismalens/gh-workflows/actions/runs/654321",
        reviewable_lines: 9000,
        max_reviewable_lines: 6000,
        lane_version: "v2.1.0",
      };

      const req = makeRequest("/ingest", {
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: laneEventPayload,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 204);
      assert.equal(db.queries.length, 1);

      const query = db.queries[0];
      assert.equal(query.args[4], "refused-size");
      assert.equal(query.args[10], 9000);
      assert.equal(query.args[11], 6000);
    });

    it("supports all six valid reasons: no-token, auto-paused, paused-by-request, fork-head, skip-author, refused-size", async () => {
      const reasons = ["no-token", "auto-paused", "paused-by-request", "fork-head", "skip-author", "refused-size"];
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

describe("computeVariantKey (#47)", () => {
  it("is stable for the same components across repeated calls", async () => {
    const a = await computeVariantKey("prompt-hash-1", "claude-sonnet-5", "action-sha-1", "config-hash-1", "review");
    const b = await computeVariantKey("prompt-hash-1", "claude-sonnet-5", "action-sha-1", "config-hash-1", "review");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("differs when any single component differs", async () => {
    const base = ["prompt-hash-1", "claude-sonnet-5", "action-sha-1", "config-hash-1", "review"];
    const baseline = await computeVariantKey(...base);

    const variedPromptHash = await computeVariantKey("prompt-hash-2", ...base.slice(1));
    const variedModel = await computeVariantKey(base[0], "claude-opus-5", ...base.slice(2));
    const variedActionVersion = await computeVariantKey(base[0], base[1], "action-sha-2", ...base.slice(3));
    const variedConfigHash = await computeVariantKey(base[0], base[1], base[2], "config-hash-2", base[4]);
    const variedRoundType = await computeVariantKey(base[0], base[1], base[2], base[3], "incremental");

    for (const [name, variant] of [
      ["prompt_hash", variedPromptHash],
      ["model", variedModel],
      ["action_version", variedActionVersion],
      ["config_hash", variedConfigHash],
      ["round_type", variedRoundType],
    ]) {
      assert.notEqual(variant, baseline, `changing ${name} alone should change variant_key`);
    }
  });

  it("treats a null component distinctly from an empty-string component", async () => {
    const withNull = await computeVariantKey(null, "claude-sonnet-5", "action-sha-1", "config-hash-1", "review");
    const withEmptyString = await computeVariantKey("", "claude-sonnet-5", "action-sha-1", "config-hash-1", "review");
    assert.notEqual(
      withNull,
      withEmptyString,
      "a missing prompt_hash and an empty-string prompt_hash must not collide"
    );
  });

  it("treats undefined the same as null (both mean the field was never sent)", async () => {
    const withNull = await computeVariantKey(null, "claude-sonnet-5", "action-sha-1", "config-hash-1", "review");
    const withUndefined = await computeVariantKey(undefined, "claude-sonnet-5", "action-sha-1", "config-hash-1", "review");
    assert.equal(withNull, withUndefined);
  });

  it("still computes a real key when every component is null", async () => {
    const allNull = await computeVariantKey(null, null, null, null, null);
    assert.match(allNull, /^[0-9a-f]{64}$/);
  });

  it("cannot be collided by a component containing the old separator or null bytes", async () => {
    // The ingest route accepts arbitrary strings, so a component may contain any byte. A
    // join-on-separator scheme let ["a\x1eb", null, ...] collide with ["a", "b", ...]. #47.
    const withSep = await computeVariantKey("a\x1eb", "m", "v", "c", "r");
    const split = await computeVariantKey("a", "\x1eb", "v", "c", "r");
    assert.notStrictEqual(withSep, split);

    const literalNull = await computeVariantKey("\x00", "m", "v", "c", "r");
    const realNull = await computeVariantKey(null, "m", "v", "c", "r");
    assert.notStrictEqual(literalNull, realNull);

    const quoteish = await computeVariantKey('a"b', "m", "v", "c", "r");
    const plain = await computeVariantKey("ab", "m", "v", "c", "r");
    assert.notStrictEqual(quoteish, plain);
  });
});

describe("Worker telemetry read API", () => {
  let accessHelper;
  let validJwt;

  // We lazily initialize the access helper once for all read tests
  async function getAccessHelper() {
    if (!accessHelper) {
      const teamDomain = "test.cloudflareaccess.com";
      const aud = "test-aud-12345";
      const kid = "test-key-id-1";

      const keyPair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
      );

      const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      jwk.kid = kid;
      jwk.alg = "RS256";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (typeof url === "string" && url.includes("/cdn-cgi/access/certs")) {
          return new Response(JSON.stringify({ keys: [jwk] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(url, init);
      };

      const header = { alg: "RS256", kid, typ: "JWT" };
      const payload = {
        aud,
        iss: `https://${teamDomain}`,
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: "user@example.com",
      };
      const enc = (obj) =>
        Buffer.from(JSON.stringify(obj))
          .toString("base64")
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");
      const headerB64 = enc(header);
      const payloadB64 = enc(payload);
      const signingInput = `${headerB64}.${payloadB64}`;
      const sigBuffer = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keyPair.privateKey,
        new TextEncoder().encode(signingInput)
      );
      const sigB64 = Buffer.from(sigBuffer)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      validJwt = `${signingInput}.${sigB64}`;

      accessHelper = {
        env: {
          ACCESS_TEAM_DOMAIN: teamDomain,
          ACCESS_AUD: aud,
        },
        jwt: validJwt,
      };
    }
    return accessHelper;
  }

  function makeAuthenticatedRequest(path, jwt, { method = "GET", headers = {}, body } = {}) {
    return makeRequest(path, {
      method,
      headers: {
        "Cf-Access-Jwt-Assertion": jwt,
        ...headers,
      },
      body,
    });
  }

  describe("Access Authentication on Read Routes", () => {
    const routes = ["/api/runs", "/api/summary", "/api/lane-events"];

    for (const route of routes) {
      it(`returns 503 on ${route} when Access is not configured in env`, async () => {
        const db = createFakeDb();
        const env = { DB: db };
        const req = makeRequest(route, { method: "GET" });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 503);
      });

      it(`returns 403 on ${route} when Cf-Access-Jwt-Assertion header is missing`, async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const req = makeRequest(route, { method: "GET" });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 403);
      });

      it(`returns 403 on ${route} when JWT is invalid`, async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const req = makeAuthenticatedRequest(route, "invalid.jwt.token");
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 403);
      });
    }
  });

  // Placed before any test that lets getSigningKeys succeed, since a successful
  // fetch populates the module-level cert cache other tests then hit. Story: #96.
  describe("verifyAccess error codes (#96)", () => {
    it("returns access_unconfigured when Access env vars are missing", async () => {
      const db = createFakeDb();
      const env = { DB: db };
      const req = makeRequest("/api/runs", { method: "GET" });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error, "access_unconfigured");
    });

    it("returns access_denied when the JWT is missing", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb();
      const env = { ...helper.env, DB: db };
      const req = makeRequest("/api/runs", { method: "GET" });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error, "access_denied");
    });

    it("returns access_keys_unavailable when the certs fetch fails", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb();
      const env = { ...helper.env, DB: db };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (typeof url === "string" && url.includes("/cdn-cgi/access/certs")) {
          throw new Error("network down");
        }
        return originalFetch(url, init);
      };
      try {
        const req = makeAuthenticatedRequest("/api/runs", helper.jwt);
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.error, "access_keys_unavailable");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("GET /api/runs (Wave 2 columns & blobs)", () => {
    it("selects all new default columns in default response and excludes blob fields", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb({
        handler: (sql) => {
          if (sql.includes("FROM usage_records")) {
            return {
              results: [
                {
                  session_id: "s-1",
                  recorded_at: "2026-08-31T12:00:00.000Z",
                  repository: "prismalens/gh-workflows",
                  pr_number: 42,
                  pr_url: "https://github.com/prismalens/gh-workflows/pull/42",
                  head_sha: "abcdef1234567890abcdef1234567890abcdef12",
                  run_id: 123456,
                  run_attempt: 1,
                  run_url: "https://github.com/prismalens/gh-workflows/actions/runs/123456",
                  round_type: "review",
                  model: "claude-3-7-sonnet",
                  input_tokens: 1000,
                  output_tokens: 500,
                  cache_read_input_tokens: 200,
                  cache_creation_input_tokens: 100,
                  total_cost_usd: 0.05,
                  duration_ms: 5000,
                  duration_api_ms: 4500,
                  num_turns: 3,
                  permission_denials: 0,
                  changed_files: 2,
                  diff_lines: 40,
                  // 15 Wave 2 default columns
                  lane_version: "v2.0.0",
                  verdict_kind: "clean",
                  inline_count: 0,
                  summary_count: 0,
                  round_ordinal: 1,
                  fallback_reason: "none",
                  range_base: "sha1",
                  range_head: "sha2",
                  model_source: "workflow-default",
                  job_conclusion: "success",
                  pr_title: "PR Title",
                  pr_author: "author",
                  pr_state: "open",
                  pr_base_ref: "main",
                  pr_head_ref: "feat/test",
                },
              ],
            };
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/runs", helper.jwt);
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.rows.length, 1);
      const row = data.rows[0];

      // Verify all 15 new default columns are present in returned row
      assert.equal(row.lane_version, "v2.0.0");
      assert.equal(row.verdict_kind, "clean");
      assert.equal(row.inline_count, 0);
      assert.equal(row.summary_count, 0);
      assert.equal(row.round_ordinal, 1);
      assert.equal(row.fallback_reason, "none");
      assert.equal(row.range_base, "sha1");
      assert.equal(row.range_head, "sha2");
      assert.equal(row.model_source, "workflow-default");
      assert.equal(row.job_conclusion, "success");
      assert.equal(row.pr_title, "PR Title");
      assert.equal(row.pr_author, "author");
      assert.equal(row.pr_state, "open");
      assert.equal(row.pr_base_ref, "main");
      assert.equal(row.pr_head_ref, "feat/test");

      // Verify SQL did not select blob columns
      const query = db.queries[0];
      assert.ok(query.sql.includes("lane_version"));
      assert.ok(query.sql.includes("verdict_kind"));
      assert.ok(query.sql.includes("inline_count"));
      assert.ok(query.sql.includes("summary_count"));
      assert.ok(query.sql.includes("round_ordinal"));
      assert.ok(query.sql.includes("fallback_reason"));
      assert.ok(query.sql.includes("range_base"));
      assert.ok(query.sql.includes("range_head"));
      assert.ok(query.sql.includes("model_source"));
      assert.ok(query.sql.includes("job_conclusion"));
      assert.ok(query.sql.includes("pr_title"));
      assert.ok(query.sql.includes("pr_author"));
      assert.ok(query.sql.includes("pr_state"));
      assert.ok(query.sql.includes("pr_base_ref"));
      assert.ok(query.sql.includes("pr_head_ref"));

      assert.ok(!query.sql.includes("verdict_text"));
      assert.ok(!query.sql.includes("comment_node_ids"));
      assert.ok(!query.sql.includes("config_resolution"));
      assert.ok(!query.sql.includes("per_model_usage"));
      assert.ok(!query.sql.includes("subagent_stats"));
      assert.ok(!query.sql.includes("raw_result"));
    });

    it("includes all 6 blob columns when include=blobs and caps limit at 50", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb();
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/runs?include=blobs&limit=100", helper.jwt);
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const query = db.queries[0];
      assert.ok(query.sql.includes("verdict_text"));
      assert.ok(query.sql.includes("comment_node_ids"));
      assert.ok(query.sql.includes("config_resolution"));
      assert.ok(query.sql.includes("per_model_usage"));
      assert.ok(query.sql.includes("subagent_stats"));
      assert.ok(query.sql.includes("raw_result"));

      // Limit bound is capped at 50
      assert.equal(query.args[query.args.length - 1], 50);
    });

    it("rejects invalid include and invalid limit with 400", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb();
      const env = { ...helper.env, DB: db };

      const badIncludeReq = makeAuthenticatedRequest("/api/runs?include=everything", helper.jwt);
      assert.equal((await worker.fetch(badIncludeReq, env)).status, 400);

      const badLimitZero = makeAuthenticatedRequest("/api/runs?limit=0", helper.jwt);
      assert.equal((await worker.fetch(badLimitZero, env)).status, 400);

      const badLimitOverMax = makeAuthenticatedRequest("/api/runs?limit=1001", helper.jwt);
      assert.equal((await worker.fetch(badLimitOverMax, env)).status, 400);
    });

    it("filters and paginates with cursor", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb({
        handler: (sql, args) => {
          if (sql.includes("FROM usage_records")) {
            return {
              results: [
                { session_id: "s-1", recorded_at: "2026-08-31T12:00:00.000Z" },
                { session_id: "s-2", recorded_at: "2026-08-31T11:00:00.000Z" },
              ],
            };
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest(
        "/api/runs?repository=prismalens/gh-workflows&since=2026-08-01T00:00:00Z&until=2026-08-31T23:59:59Z&cursor=2026-08-31T13:00:00Z|s-0&limit=2",
        helper.jwt
      );
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.rows.length, 2);
      assert.equal(data.next_cursor, "2026-08-31T11:00:00.000Z|s-2");

      const query = db.queries[0];
      assert.ok(query.sql.includes("repository = ?"));
      assert.ok(query.sql.includes("recorded_at >= ?"));
      assert.ok(query.sql.includes("recorded_at <= ?"));
      assert.ok(query.sql.includes("(recorded_at < ? OR (recorded_at = ? AND session_id < ?))"));
    });
  });

  describe("GET /api/summary (Aggregates & Canary Freshness)", () => {
    it("returns count breakdowns and canary_last_seen_at using aggregate SQL", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb({
        handler: (sql) => {
          if (sql.includes("FROM canary_pings")) {
            return { last_seen_at: "2026-08-31T20:00:00.000Z" };
          }
          if (sql.includes("COUNT(*) as rows")) {
            return {
              rows: 10,
              mean_duration: 5000,
              denials_per_run: 0.1,
              sum_input: 10000,
              sum_read: 5000,
              sum_create: 2000,
              total_cost_usd: 0.5,
              first_recorded_at: "2026-08-01T00:00:00.000Z",
              last_recorded_at: "2026-08-31T20:00:00.000Z",
            };
          }
          if (sql.includes("DISTINCT repository")) {
            return [{ repository: "prismalens/gh-workflows" }];
          }
          if (sql.includes("WHERE verdict_kind IS NOT NULL")) {
            return [
              { verdict_kind: "clean", cnt: 8 },
              { verdict_kind: "findings", cnt: 2 },
            ];
          }
          if (sql.includes("WHERE fallback_reason IS NOT NULL")) {
            return [{ fallback_reason: "none", cnt: 10 }];
          }
          if (sql.includes("WHERE model_source IS NOT NULL")) {
            return [{ model_source: "workflow-default", cnt: 10 }];
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/summary", helper.jwt);
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.rows, 10);
      assert.equal(data.canary_last_seen_at, "2026-08-31T20:00:00.000Z");
      assert.deepEqual(data.verdict_kinds, { clean: 8, findings: 2 });
      assert.deepEqual(data.fallback_reasons, { none: 10 });
      assert.deepEqual(data.model_sources, { "workflow-default": 10 });

      // Verify aggregate SQL was used for breakdowns
      const sqlQueries = db.queries.map((q) => q.sql);
      assert.ok(sqlQueries.some((s) => s.includes("GROUP BY verdict_kind")));
      assert.ok(sqlQueries.some((s) => s.includes("GROUP BY fallback_reason")));
      assert.ok(sqlQueries.some((s) => s.includes("GROUP BY model_source")));
    });

    it("carries a per-repository array from one grouped query, for the repos page's quiet-repository card (#142 finding 3944697641)", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb({
        handler: (sql) => {
          if (sql.includes("FROM canary_pings")) {
            return { last_seen_at: "2026-08-31T20:00:00.000Z" };
          }
          if (sql.includes("COUNT(*) as rows")) {
            return { rows: 10, first_recorded_at: "2026-08-01T00:00:00.000Z" };
          }
          if (sql.includes("DISTINCT repository")) {
            return [
              { repository: "prismalens/gh-workflows" },
              { repository: "prismalens/quiet-repo" },
            ];
          }
          if (sql.includes("GROUP BY repository")) {
            return [
              { repository: "prismalens/gh-workflows", rounds: 9, last_recorded_at: "2026-08-31T20:00:00.000Z" },
              { repository: "prismalens/quiet-repo", rounds: 1, last_recorded_at: "2026-07-15T00:00:00.000Z" },
            ];
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/summary", helper.jwt);
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.deepEqual(data.per_repository, [
        { repository: "prismalens/gh-workflows", rounds: 9, last_recorded_at: "2026-08-31T20:00:00.000Z" },
        { repository: "prismalens/quiet-repo", rounds: 1, last_recorded_at: "2026-07-15T00:00:00.000Z" },
      ]);

      const sqlQueries = db.queries.map((q) => q.sql);
      assert.ok(sqlQueries.some((s) => s.includes("GROUP BY repository")));
    });

    it("returns canary_last_seen_at as null, not 0 and not absent, when canary_pings is empty", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb({
        handler: (sql) => {
          if (sql.includes("FROM canary_pings")) {
            return null;
          }
          if (sql.includes("COUNT(*) as rows")) {
            return { rows: 0 };
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/summary", helper.jwt);
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.rows, 0);
      assert.ok("canary_last_seen_at" in data);
      assert.equal(data.canary_last_seen_at, null);
      assert.notEqual(data.canary_last_seen_at, 0);
      assert.deepEqual(data.verdict_kinds, {});
      assert.deepEqual(data.fallback_reasons, {});
      assert.deepEqual(data.model_sources, {});
    });

    it("returns canary_last_seen_at even when usage_records is empty", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb({
        handler: (sql) => {
          if (sql.includes("FROM canary_pings")) {
            return { last_seen_at: "2026-08-31T21:00:00.000Z" };
          }
          if (sql.includes("COUNT(*) as rows")) {
            return { rows: 0 };
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/summary", helper.jwt);
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.rows, 0);
      assert.equal(data.canary_last_seen_at, "2026-08-31T21:00:00.000Z");
      assert.deepEqual(data.verdict_kinds, {});
    });
  });

  describe("GET /api/lane-events (Filtering, Pagination & Ordering)", () => {
    it("returns lane_events columns, filters by repository and since, respects limit, and paginates", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb({
        handler: (sql, args) => {
          if (sql.includes("FROM lane_events")) {
            return {
              results: [
                {
                  run_id: 1002,
                  run_attempt: 1,
                  recorded_at: "2026-08-31T15:00:00.000Z",
                  repository: "prismalens/gh-workflows",
                  reason: "auto-paused",
                  pr_number: 55,
                  head_sha: "aabbcc112233",
                  run_url: "https://github.com/prismalens/gh-workflows/actions/runs/1002",
                  rounds_used: 3,
                  lane_version: "v2.0.0",
                },
                {
                  run_id: 1001,
                  run_attempt: 1,
                  recorded_at: "2026-08-31T14:00:00.000Z",
                  repository: "prismalens/gh-workflows",
                  reason: "no-token",
                  pr_number: 54,
                  head_sha: "ddeeff445566",
                  run_url: "https://github.com/prismalens/gh-workflows/actions/runs/1001",
                  rounds_used: 0,
                  lane_version: "v2.0.0",
                },
              ],
            };
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest(
        "/api/lane-events?repository=prismalens/gh-workflows&since=2026-08-01T00:00:00Z&until=2026-08-31T23:59:59Z&limit=2",
        helper.jwt
      );
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.rows.length, 2);
      assert.equal(data.rows[0].reason, "auto-paused");
      assert.equal(data.rows[0].rounds_used, 3);
      assert.equal(data.rows[0].lane_version, "v2.0.0");
      assert.equal(data.rows[1].reason, "no-token");
      assert.equal(data.next_cursor, "2026-08-31T14:00:00.000Z|1001");

      const query = db.queries[0];
      assert.ok(query.sql.includes("repository = ?"));
      assert.ok(query.sql.includes("recorded_at >= ?"));
      assert.ok(query.sql.includes("recorded_at <= ?"));
      assert.ok(query.sql.includes("ORDER BY recorded_at DESC, run_id DESC"));
      assert.equal(query.args[query.args.length - 1], 2);
    });

    it("selects reviewable_lines and max_reviewable_lines so a refused-size round can show its counts (#105)", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb({
        handler: (sql, args) => {
          if (sql.includes("FROM lane_events")) {
            return {
              results: [
                {
                  run_id: 1003,
                  run_attempt: 1,
                  recorded_at: "2026-08-31T16:00:00.000Z",
                  repository: "prismalens/gh-workflows",
                  reason: "refused-size",
                  pr_number: 56,
                  head_sha: "112233aabbcc",
                  run_url: "https://github.com/prismalens/gh-workflows/actions/runs/1003",
                  rounds_used: null,
                  lane_version: "v2.0.0",
                  reviewable_lines: 9000,
                  max_reviewable_lines: 6000,
                },
              ],
            };
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/lane-events", helper.jwt);
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.rows[0].reviewable_lines, 9000);
      assert.equal(data.rows[0].max_reviewable_lines, 6000);

      const query = db.queries[0];
      assert.ok(query.sql.includes("reviewable_lines"));
      assert.ok(query.sql.includes("max_reviewable_lines"));
    });

    it("handles cursor pagination and rejects invalid cursor or limit", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb();
      const env = { ...helper.env, DB: db };

      const badLimitReq = makeAuthenticatedRequest("/api/lane-events?limit=0", helper.jwt);
      assert.equal((await worker.fetch(badLimitReq, env)).status, 400);

      const badCursorReq = makeAuthenticatedRequest("/api/lane-events?cursor=not-a-valid-cursor", helper.jwt);
      assert.equal((await worker.fetch(badCursorReq, env)).status, 400);

      const cursorReq = makeAuthenticatedRequest(
        "/api/lane-events?cursor=2026-08-31T15:00:00.000Z|1002",
        helper.jwt
      );
      const res = await worker.fetch(cursorReq, env);
      assert.equal(res.status, 200);

      const query = db.queries[0];
      assert.ok(query.sql.includes("(recorded_at < ? OR (recorded_at = ? AND run_id < ?))"));
      assert.deepEqual(query.args, ["2026-08-31T15:00:00.000Z", "2026-08-31T15:00:00.000Z", 1002, 100]);
    });
  });

  describe("GET /api/round-agents (#93)", () => {
    it("returns 503 when Access is not configured in env", async () => {
      const db = createFakeDb();
      const env = { DB: db };
      const req = makeRequest("/api/round-agents?session_id=s-1", { method: "GET" });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 503);
    });

    it("returns 403 when Cf-Access-Jwt-Assertion header is missing", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb();
      const env = { ...helper.env, DB: db };
      const req = makeRequest("/api/round-agents?session_id=s-1", { method: "GET" });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 403);
    });

    it("returns 403 when JWT is invalid", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb();
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/round-agents?session_id=s-1", "invalid.jwt.token");
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 403);
    });

    it("returns 400 when session_id query param is missing", async () => {
      const helper = await getAccessHelper();
      const db = createFakeDb();
      const env = { ...helper.env, DB: db };
      const req = makeAuthenticatedRequest("/api/round-agents", helper.jwt);
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /session_id/);
    });

    it("returns the rows for one session and not another's", async () => {
      const helper = await getAccessHelper();
      const sessionAgents = {
        "session-A": [
          {
            session_id: "session-A",
            agent_id: "agent-01",
            subagent_type: "worker",
            spawn_depth: 1,
            status: "completed",
            model: "claude-3-5-sonnet",
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            duration_ms: 3000,
            tool_uses: 2,
            tool_uses_by_name: "{}",
            file_paths: "[]",
          },
          {
            session_id: "session-A",
            agent_id: "agent-02",
            subagent_type: "reviewer",
            spawn_depth: 1,
            status: "completed",
            model: "claude-3-5-haiku",
            input_tokens: 500,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            duration_ms: 1500,
            tool_uses: 1,
            tool_uses_by_name: "{}",
            file_paths: "[]",
          },
        ],
        "session-B": [
          {
            session_id: "session-B",
            agent_id: "agent-99",
            subagent_type: "worker",
            spawn_depth: 1,
            status: "failed",
            model: "claude-3-5-sonnet",
            input_tokens: 2000,
            output_tokens: 400,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            duration_ms: 4000,
            tool_uses: 3,
            tool_uses_by_name: "{}",
            file_paths: "[]",
          },
        ],
      };

      const db = createFakeDb({
        handler: (sql, args) => {
          if (sql.includes("FROM round_agents")) {
            const sid = args[0];
            return {
              results: sessionAgents[sid] ?? [],
            };
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };

      const reqA = makeAuthenticatedRequest("/api/round-agents?session_id=session-A", helper.jwt);
      const resA = await worker.fetch(reqA, env);
      assert.equal(resA.status, 200);
      const dataA = await resA.json();
      assert.equal(dataA.rows.length, 2);
      assert.equal(dataA.rows[0].agent_id, "agent-01");
      assert.equal(dataA.rows[1].agent_id, "agent-02");
      assert.equal(dataA.next_cursor, null);

      const queryA = db.queries[0];
      assert.ok(queryA.sql.includes("FROM round_agents"));
      assert.ok(queryA.sql.includes("WHERE session_id = ?"));
      assert.ok(queryA.sql.includes("ORDER BY agent_id ASC"));
      assert.equal(queryA.args[0], "session-A");

      // Request session-B
      const reqB = makeAuthenticatedRequest("/api/round-agents?session_id=session-B", helper.jwt);
      const resB = await worker.fetch(reqB, env);
      assert.equal(resB.status, 200);
      const dataB = await resB.json();
      assert.equal(dataB.rows.length, 1);
      assert.equal(dataB.rows[0].agent_id, "agent-99");
      assert.equal(dataB.rows[0].session_id, "session-B");
      assert.equal(dataB.next_cursor, null);

      // Request non-existent session
      const reqC = makeAuthenticatedRequest("/api/round-agents?session_id=session-nonexistent", helper.jwt);
      const resC = await worker.fetch(reqC, env);
      assert.equal(resC.status, 200);
      const dataC = await resC.json();
      assert.deepEqual(dataC.rows, []);
      assert.equal(dataC.next_cursor, null);
    });

    it("honors the limit query parameter instead of the hardcoded 64 (#141)", async () => {
      const helper = await getAccessHelper();
      const threeAgents = ["agent-01", "agent-02", "agent-03"].map((agentId) => ({
        session_id: "s-1",
        agent_id: agentId,
        subagent_type: "worker",
        spawn_depth: 1,
        status: "completed",
        model: "claude-3-5-sonnet",
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        duration_ms: 500,
        tool_uses: 1,
        tool_uses_by_name: "{}",
        file_paths: "[]",
      }));

      const db = createFakeDb({
        handler: (sql, args) => {
          if (sql.includes("FROM round_agents")) {
            assert.ok(sql.includes("LIMIT ?"));
            const limit = args[1];
            return { results: threeAgents.slice(0, limit) };
          }
          return null;
        },
      });
      const env = { ...helper.env, DB: db };

      const req = makeAuthenticatedRequest(
        "/api/round-agents?session_id=s-1&limit=2",
        helper.jwt,
      );
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.rows.length, 2);

      const query = db.queries[0];
      assert.equal(query.args[0], "s-1");
      assert.equal(query.args[1], 2);
    });
  });

  describe("Changes Registry API (/api/changes)", () => {
    describe("Access Authentication on Changes Routes", () => {
      const cases = [
        { route: "/api/changes", method: "GET" },
        {
          route: "/api/changes",
          method: "POST",
          body: {
            name: "Upgrade model",
            at: "2026-08-31T12:00:00.000Z",
            scope: "repo",
            repository: "prismalens/gh-workflows",
          },
        },
        { route: "/api/changes/test-change-uuid-1", method: "DELETE" },
      ];

      for (const { route, method, body } of cases) {
        it(`returns 503 on ${method} ${route} when Access is not configured in env`, async () => {
          const db = createFakeDb();
          const env = { DB: db };
          const req = makeRequest(route, { method, body });
          const res = await worker.fetch(req, env);
          assert.equal(res.status, 503);
        });

        it(`returns 403 on ${method} ${route} when Cf-Access-Jwt-Assertion header is missing`, async () => {
          const helper = await getAccessHelper();
          const db = createFakeDb();
          const env = { ...helper.env, DB: db };
          const req = makeRequest(route, { method, body });
          const res = await worker.fetch(req, env);
          assert.equal(res.status, 403);
        });

        it(`returns 403 on ${method} ${route} when JWT is invalid`, async () => {
          const helper = await getAccessHelper();
          const db = createFakeDb();
          const env = { ...helper.env, DB: db };
          const req = makeAuthenticatedRequest(route, "invalid.jwt.token", { method, body });
          const res = await worker.fetch(req, env);
          assert.equal(res.status, 403);
        });
      }
    });

    describe("POST /api/changes (Creation & Validation)", () => {
      it("a valid repo-scoped create stores every field, with a server-generated id and created_at", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const payload = {
          name: "Upgrade reviewer to Claude 3.7 Sonnet",
          at: "2026-08-31T12:00:00.000Z",
          source_url: "https://github.com/prismalens/gh-workflows/pull/73",
          scope: "repo",
          repository: "prismalens/gh-workflows",
        };

        const req = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: payload,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 201);

        const data = await res.json();
        assert.ok(typeof data.id === "string" && data.id.length > 0);
        assert.match(
          data.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
        assert.ok(typeof data.created_at === "string" && data.created_at.length > 0);
        assert.equal(data.name, payload.name);
        assert.equal(data.at, payload.at);
        assert.equal(data.source_url, payload.source_url);
        assert.equal(data.scope, "repo");
        assert.equal(data.repository, "prismalens/gh-workflows");

        assert.equal(db.queries.length, 1);
        const query = db.queries[0];
        assert.match(query.sql, /INSERT INTO changes/);
        assert.deepEqual(query.args, [
          data.id,
          payload.name,
          payload.at,
          payload.source_url,
          "repo",
          "prismalens/gh-workflows",
          data.created_at,
        ]);
      });

      it("a valid fleet-scoped create with no repository stores", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const payload = {
          name: "Fleetwide prompt update",
          at: "2026-08-31T10:00:00.000Z",
          scope: "fleet",
        };

        const req = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: payload,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 201);

        const data = await res.json();
        assert.equal(data.name, payload.name);
        assert.equal(data.at, payload.at);
        assert.equal(data.scope, "fleet");
        assert.equal(data.repository, null);
        assert.equal(data.source_url, null);

        assert.equal(db.queries.length, 1);
        const query = db.queries[0];
        assert.equal(query.args[4], "fleet");
        assert.equal(query.args[5], null);
        assert.equal(query.args[3], null);
      });

      it("scope: 'fleet' with a repository is 400, and scope: 'repo' without one is 400", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        // fleet with repository
        const fleetWithRepoReq = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: "Fleet change with repo",
            at: "2026-08-31T10:00:00.000Z",
            scope: "fleet",
            repository: "prismalens/gh-workflows",
          },
        });
        const fleetWithRepoRes = await worker.fetch(fleetWithRepoReq, env);
        assert.equal(fleetWithRepoRes.status, 400);

        // repo without repository
        const repoWithoutRepoReq = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: "Repo change missing repo",
            at: "2026-08-31T10:00:00.000Z",
            scope: "repo",
          },
        });
        const repoWithoutRepoRes = await worker.fetch(repoWithoutRepoReq, env);
        assert.equal(repoWithoutRepoRes.status, 400);

        // repo with empty string repository
        const repoEmptyRepoReq = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: "Repo change empty repo",
            at: "2026-08-31T10:00:00.000Z",
            scope: "repo",
            repository: "",
          },
        });
        const repoEmptyRepoRes = await worker.fetch(repoEmptyRepoReq, env);
        assert.equal(repoEmptyRepoRes.status, 400);

        assert.equal(db.queries.length, 0);
      });

      it("an unknown scope is 400", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        for (const badScope of ["org", "global", "repository", "", null, 123]) {
          const req = makeAuthenticatedRequest("/api/changes", helper.jwt, {
            method: "POST",
            body: {
              name: "Bad scope change",
              at: "2026-08-31T10:00:00.000Z",
              scope: badScope,
              repository: "prismalens/gh-workflows",
            },
          });
          const res = await worker.fetch(req, env);
          assert.equal(res.status, 400, `Expected 400 for scope: ${badScope}`);
        }
        assert.equal(db.queries.length, 0);
      });

      it("a non-ISO at is 400; a valid non-UTC at is stored normalised to UTC", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        // Non-ISO dates
        for (const badAt of ["not-a-date", "2026-99-99T99:99:99Z", "2026-08-31", "", 123456789]) {
          const req = makeAuthenticatedRequest("/api/changes", helper.jwt, {
            method: "POST",
            body: {
              name: "Bad at change",
              at: badAt,
              scope: "fleet",
            },
          });
          const res = await worker.fetch(req, env);
          assert.equal(res.status, 400, `Expected 400 for at: ${badAt}`);
        }
        assert.equal(db.queries.length, 0);

        // Valid non-UTC at normalized to UTC (+02:00 -> -2 hours to UTC)
        const nonUtcReq = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: "Non-UTC at change",
            at: "2026-08-31T15:00:00+02:00",
            scope: "fleet",
          },
        });
        const nonUtcRes = await worker.fetch(nonUtcReq, env);
        assert.equal(nonUtcRes.status, 201);
        const data = await nonUtcRes.json();
        assert.equal(data.at, "2026-08-31T13:00:00.000Z");

        assert.equal(db.queries.length, 1);
        assert.equal(db.queries[0].args[2], "2026-08-31T13:00:00.000Z");
      });

      it("an http:// source_url is 400", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        const httpReq = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: "Insecure url change",
            at: "2026-08-31T12:00:00.000Z",
            scope: "fleet",
            source_url: "http://github.com/prismalens/gh-workflows/pull/73",
          },
        });
        const httpRes = await worker.fetch(httpReq, env);
        assert.equal(httpRes.status, 400);

        const longUrl = "https://example.com/" + "x".repeat(500);
        const tooLongUrlReq = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: "Too long url change",
            at: "2026-08-31T12:00:00.000Z",
            scope: "fleet",
            source_url: longUrl,
          },
        });
        const tooLongUrlRes = await worker.fetch(tooLongUrlReq, env);
        assert.equal(tooLongUrlRes.status, 400);

        assert.equal(db.queries.length, 0);
      });

      it("a 201-character name is 400", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        const overLimitName = "N".repeat(201);
        const req = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: overLimitName,
            at: "2026-08-31T12:00:00.000Z",
            scope: "fleet",
          },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);

        // Empty name
        const emptyReq = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: "",
            at: "2026-08-31T12:00:00.000Z",
            scope: "fleet",
          },
        });
        const emptyRes = await worker.fetch(emptyReq, env);
        assert.equal(emptyRes.status, 400);

        // Valid 200-character name
        const validMaxName = "N".repeat(200);
        const validMaxReq = makeAuthenticatedRequest("/api/changes", helper.jwt, {
          method: "POST",
          body: {
            name: validMaxName,
            at: "2026-08-31T12:00:00.000Z",
            scope: "fleet",
          },
        });
        const validMaxRes = await worker.fetch(validMaxReq, env);
        assert.equal(validMaxRes.status, 201);
      });
    });

    describe("GET /api/changes (Listing & Pagination)", () => {
      it("GET returns rows ordered by at descending and paginates", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb({
          handler: (sql, args) => {
            if (sql.includes("FROM changes")) {
              return {
                results: [
                  {
                    id: "change-uuid-2",
                    name: "Upgrade reviewer to Claude 3.7 Sonnet",
                    at: "2026-08-31T14:00:00.000Z",
                    source_url: "https://github.com/prismalens/gh-workflows/pull/73",
                    scope: "repo",
                    repository: "prismalens/gh-workflows",
                    created_at: "2026-08-31T14:05:00.000Z",
                  },
                  {
                    id: "change-uuid-1",
                    name: "Fleetwide prompt update",
                    at: "2026-08-31T10:00:00.000Z",
                    source_url: null,
                    scope: "fleet",
                    repository: null,
                    created_at: "2026-08-31T10:05:00.000Z",
                  },
                ],
              };
            }
            return null;
          },
        });
        const env = { ...helper.env, DB: db };
        const req = makeAuthenticatedRequest("/api/changes?limit=2", helper.jwt);
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);

        const data = await res.json();
        assert.equal(data.rows.length, 2);
        assert.equal(data.rows[0].id, "change-uuid-2");
        assert.equal(data.rows[0].at, "2026-08-31T14:00:00.000Z");
        assert.equal(data.rows[1].id, "change-uuid-1");
        assert.equal(data.rows[1].at, "2026-08-31T10:00:00.000Z");
        assert.equal(data.next_cursor, "2026-08-31T10:00:00.000Z|change-uuid-1");

        const query = db.queries[0];
        assert.ok(query.sql.includes("ORDER BY at DESC, id DESC LIMIT ?"));
        assert.equal(query.args[query.args.length - 1], 2);
      });

      it("handles cursor pagination and rejects invalid cursor or limit", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        const badLimitReq = makeAuthenticatedRequest("/api/changes?limit=0", helper.jwt);
        assert.equal((await worker.fetch(badLimitReq, env)).status, 400);

        const badCursorReq = makeAuthenticatedRequest("/api/changes?cursor=no-pipe-symbol", helper.jwt);
        assert.equal((await worker.fetch(badCursorReq, env)).status, 400);

        const cursorReq = makeAuthenticatedRequest(
          "/api/changes?cursor=2026-08-31T14:00:00.000Z|change-uuid-2",
          helper.jwt
        );
        const res = await worker.fetch(cursorReq, env);
        assert.equal(res.status, 200);

        const query = db.queries[0];
        assert.ok(query.sql.includes("(at < ? OR (at = ? AND id < ?))"));
        assert.deepEqual(query.args, [
          "2026-08-31T14:00:00.000Z",
          "2026-08-31T14:00:00.000Z",
          "change-uuid-2",
          100,
        ]);
      });
    });

    describe("DELETE /api/changes/:id (Deletion & Idempotency)", () => {
      it("DELETE removes the row and is idempotent about an id that is not there", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        // Deleting existing or non-existing row returns 204
        const req = makeAuthenticatedRequest("/api/changes/some-change-uuid", helper.jwt, {
          method: "DELETE",
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 204);

        assert.equal(db.queries.length, 1);
        const query = db.queries[0];
        assert.equal(query.sql, "DELETE FROM changes WHERE id = ?");
        assert.deepEqual(query.args, ["some-change-uuid"]);

        // Calling again with an id that is not there also returns 204
        const req2 = makeAuthenticatedRequest("/api/changes/non-existent-uuid", helper.jwt, {
          method: "DELETE",
        });
        const res2 = await worker.fetch(req2, env);
        assert.equal(res2.status, 204);
        assert.equal(db.queries.length, 2);
        assert.deepEqual(db.queries[1].args, ["non-existent-uuid"]);
      });
    });
  });

  describe("PR State API (#136)", () => {
    describe("POST /pr-state (Authentication & Ingest)", () => {
      it("returns 401 when authorization header is missing", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          body: { repository: "prismalens/gh-workflows", pr_number: 1, source: "hook" },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 401);
        assert.equal(db.queries.length, 0);
      });

      it("returns 401 when token is wrong", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: "Bearer wrong-token" },
          body: { repository: "prismalens/gh-workflows", pr_number: 1, source: "hook" },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 401);
        assert.equal(db.queries.length, 0);
      });

      it("returns 400 when repository is missing or not a string", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: { pr_number: 1, source: "hook" },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.error, "missing or invalid repository");
      });

      it("returns 400 when pr_number is missing or not an integer", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: { repository: "prismalens/gh-workflows", pr_number: "not-int", source: "hook" },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.error, "missing or invalid pr_number");
      });

      it("returns 400 when source is invalid", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: { repository: "prismalens/gh-workflows", pr_number: 1, source: "invalid-source" },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.error, "invalid source");
      });

      it("returns 400 when state is invalid", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            repository: "prismalens/gh-workflows",
            pr_number: 1,
            state: "in_progress",
            source: "hook",
          },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.error, "invalid state");
      });

      it("returns 400 when optional string field has invalid type", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            repository: "prismalens/gh-workflows",
            pr_number: 1,
            source: "hook",
            title: 12345,
          },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.error, "invalid field types");
      });

      it("creates a new PR row via upsert", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            repository: "prismalens/gh-workflows",
            pr_number: 136,
            state: "open",
            title: "feat: a prs table",
            author: "alice",
            base_ref: "main",
            head_ref: "feat/prs-table",
            head_sha: "abc1234",
            source: "hook",
          },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 204);

        assert.equal(db.queries.length, 2);
        const [selectQuery, insertQuery] = db.queries;
        assert.ok(selectQuery.sql.includes("SELECT updated_at FROM prs"));
        assert.deepEqual(selectQuery.args, ["prismalens/gh-workflows", 136]);

        assert.ok(insertQuery.sql.includes("INSERT INTO prs"));
        assert.ok(insertQuery.sql.includes("ON CONFLICT(repository, pr_number) DO UPDATE SET"));
        assert.equal(insertQuery.args[0], "prismalens/gh-workflows");
        assert.equal(insertQuery.args[1], 136);
        assert.equal(insertQuery.args[2], "open");
        assert.equal(insertQuery.args[3], "feat: a prs table");
        assert.equal(insertQuery.args[4], "alice");
        assert.equal(insertQuery.args[5], "main");
        assert.equal(insertQuery.args[6], "feat/prs-table");
        assert.equal(insertQuery.args[7], "abc1234");
        assert.equal(insertQuery.args[8], null); // merged_at
        assert.equal(insertQuery.args[9], null); // closed_at
        assert.ok(typeof insertQuery.args[10] === "string"); // updated_at
        assert.equal(insertQuery.args[11], "hook");
      });

      it("updates an existing row leaving absent fields untouched rather than nulling them", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            repository: "prismalens/gh-workflows",
            pr_number: 136,
            state: "closed",
            source: "hook",
          },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 204);

        assert.equal(db.queries.length, 2);
        const insertQuery = db.queries[1];
        assert.ok(insertQuery.sql.includes("title = COALESCE(excluded.title, prs.title)"));
        assert.ok(insertQuery.sql.includes("author = COALESCE(excluded.author, prs.author)"));
        assert.ok(insertQuery.sql.includes("base_ref = COALESCE(excluded.base_ref, prs.base_ref)"));
        assert.ok(insertQuery.sql.includes("head_ref = COALESCE(excluded.head_ref, prs.head_ref)"));
        assert.ok(insertQuery.sql.includes("head_sha = COALESCE(excluded.head_sha, prs.head_sha)"));
        assert.ok(insertQuery.sql.includes("merged_at = COALESCE(excluded.merged_at, prs.merged_at)"));
        assert.ok(insertQuery.sql.includes("closed_at = COALESCE(excluded.closed_at, prs.closed_at)"));

        assert.equal(insertQuery.args[2], "closed"); // state is updated
        assert.equal(insertQuery.args[3], null); // title remains unchanged in DB
        assert.equal(insertQuery.args[4], null); // author remains unchanged in DB
      });

      it("an older write loses to a newer one", async () => {
        const db = createFakeDb({
          handler: (sql, args) => {
            if (sql.includes("SELECT updated_at FROM prs")) {
              return { first: { updated_at: "2099-01-01T00:00:00.000Z" } };
            }
            return null;
          },
        });
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            repository: "prismalens/gh-workflows",
            pr_number: 136,
            state: "open",
            source: "reconciler",
          },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 204);

        assert.equal(db.queries.length, 1);
        assert.ok(db.queries[0].sql.includes("SELECT updated_at FROM prs"));
      });

      it("rejects invalid updated_at in POST /pr-state (#136, finding 3944010389)", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            repository: "prismalens/gh-workflows",
            pr_number: 136,
            state: "open",
            source: "hook",
            updated_at: "invalid-date",
          },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.error, "invalid updated_at");
        assert.equal(db.queries.length, 0);
      });

      it("respects event updated_at and drops out-of-order writes with older event timestamps (#136, finding 3944010389)", async () => {
        const db = createFakeDb({
          handler: (sql, args) => {
            if (sql.includes("SELECT updated_at FROM prs")) {
              return { first: { updated_at: "2026-09-06T12:00:00.000Z" } };
            }
            return null;
          },
        });
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };

        // Out-of-order write with older updated_at is dropped
        const olderReq = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            repository: "prismalens/gh-workflows",
            pr_number: 136,
            state: "open",
            source: "hook",
            updated_at: "2026-09-06T11:00:00.000Z",
          },
        });
        const olderRes = await worker.fetch(olderReq, env);
        assert.equal(olderRes.status, 204);
        assert.equal(db.queries.length, 1); // Only the SELECT query ran

        // Newer write succeeds and writes the supplied updated_at
        const newerReq = makeRequest("/pr-state", {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
          body: {
            repository: "prismalens/gh-workflows",
            pr_number: 136,
            state: "closed",
            source: "hook",
            updated_at: "2026-09-06T13:00:00.000Z",
          },
        });
        const newerRes = await worker.fetch(newerReq, env);
        assert.equal(newerRes.status, 204);
        assert.equal(db.queries.length, 3); // SELECT + INSERT
        const insertQuery = db.queries[2];
        assert.ok(insertQuery.sql.includes("INSERT INTO prs"));
        assert.equal(insertQuery.args[10], "2026-09-06T13:00:00.000Z");
      });
    });

    describe("GET /api/prs (Read Route & Pagination)", () => {
      it("returns 403 when Cf-Access-Jwt-Assertion header is missing", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const req = makeRequest("/api/prs", { method: "GET" });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 403);
      });

      it("returns rows and next_cursor with Access auth", async () => {
        const helper = await getAccessHelper();
        const sampleRows = [
          {
            repository: "prismalens/gh-workflows",
            pr_number: 136,
            state: "open",
            title: "feat: a prs table",
            author: "alice",
            base_ref: "main",
            head_ref: "feat/prs-table",
            head_sha: "abc1234",
            merged_at: null,
            closed_at: null,
            updated_at: "2026-09-06T12:00:00.000Z",
            source: "hook",
          },
        ];
        const db = createFakeDb({
          handler: (sql, args) => {
            if (sql.includes("FROM prs")) {
              return { results: sampleRows };
            }
            return null;
          },
        });
        const env = { ...helper.env, DB: db };
        const req = makeAuthenticatedRequest("/api/prs?limit=1", helper.jwt);
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);

        const data = await res.json();
        assert.equal(data.rows.length, 1);
        assert.equal(data.rows[0].repository, "prismalens/gh-workflows");
        assert.equal(data.rows[0].pr_number, 136);
        assert.equal(data.rows[0].state, "open");
        assert.equal(data.next_cursor, "2026-09-06T12:00:00.000Z|prismalens/gh-workflows|136");

        const query = db.queries[0];
        assert.ok(query.sql.includes("ORDER BY updated_at DESC, repository DESC, pr_number DESC LIMIT ?"));
        assert.equal(query.args[query.args.length - 1], 1);
      });

      it("filters by repository", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const req = makeAuthenticatedRequest("/api/prs?repository=prismalens/gh-workflows", helper.jwt);
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);

        const query = db.queries[0];
        assert.ok(query.sql.includes("repository = ?"));
        assert.equal(query.args[0], "prismalens/gh-workflows");
      });

      it("filters by state", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const req = makeAuthenticatedRequest("/api/prs?state=merged", helper.jwt);
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);

        const query = db.queries[0];
        assert.ok(query.sql.includes("state = ?"));
        assert.equal(query.args[0], "merged");
      });

      it("filters by both repository and state", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const req = makeAuthenticatedRequest("/api/prs?repository=prismalens/gh-workflows&state=closed", helper.jwt);
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);

        const query = db.queries[0];
        assert.ok(query.sql.includes("repository = ? AND state = ?"));
        assert.equal(query.args[0], "prismalens/gh-workflows");
        assert.equal(query.args[1], "closed");
      });

      it("rejects invalid limit", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };
        const req = makeAuthenticatedRequest("/api/prs?limit=0", helper.jwt);
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
      });

      it("handles cursor pagination and rejects invalid cursor", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        const badCursorReq = makeAuthenticatedRequest("/api/prs?cursor=no-pipe", helper.jwt);
        assert.equal((await worker.fetch(badCursorReq, env)).status, 400);

        const cursorReq = makeAuthenticatedRequest(
          "/api/prs?cursor=2026-09-06T12:00:00.000Z|prismalens/gh-workflows|136",
          helper.jwt
        );
        const res = await worker.fetch(cursorReq, env);
        assert.equal(res.status, 200);

        const query = db.queries[0];
        assert.ok(query.sql.includes("updated_at < ?"));
        assert.equal(query.args[0], "2026-09-06T12:00:00.000Z");
        assert.equal(query.args[2], "prismalens/gh-workflows");
        assert.equal(query.args[4], 136);
      });

      it("two-part cursor is rejected without repository and accepted with repository (#136, finding 3944010384)", async () => {
        const helper = await getAccessHelper();
        const db = createFakeDb();
        const env = { ...helper.env, DB: db };

        // Two-part cursor without repository filter is rejected with 400
        const noRepoReq = makeAuthenticatedRequest(
          "/api/prs?cursor=2026-09-06T12:00:00.000Z|136",
          helper.jwt
        );
        const noRepoRes = await worker.fetch(noRepoReq, env);
        assert.equal(noRepoRes.status, 400);
        const errBody = await noRepoRes.json();
        assert.equal(errBody.error, "invalid cursor");

        // Two-part cursor with repository filter is accepted
        const repoReq = makeAuthenticatedRequest(
          "/api/prs?repository=prismalens/gh-workflows&cursor=2026-09-06T12:00:00.000Z|136",
          helper.jwt
        );
        const repoRes = await worker.fetch(repoReq, env);
        assert.equal(repoRes.status, 200);

        const query = db.queries[0];
        assert.ok(query.sql.includes("(updated_at < ? OR (updated_at = ? AND pr_number < ?))"));
        assert.equal(query.args[0], "prismalens/gh-workflows");
        assert.equal(query.args[1], "2026-09-06T12:00:00.000Z");
        assert.equal(query.args[2], "2026-09-06T12:00:00.000Z");
        assert.equal(query.args[3], 136);
      });
    });
  });

  describe("GET /api/accounted-runs (#87)", () => {
    const validRepo = "prismalens/gh-workflows";
    const validSince = "2026-08-30T00:00:00Z";
    const validUntil = "2026-08-31T02:00:00Z";

    describe("Authentication", () => {
      it("returns 401 when authorization header is missing", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=${validUntil}`, {
          method: "GET",
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.error, "unauthorized");
        assert.equal(db.queries.length, 0);
      });

      it("returns 401 when authorization token is wrong", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=${validUntil}`, {
          method: "GET",
          headers: { authorization: "Bearer wrong-secret-token" },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.error, "unauthorized");
        assert.equal(db.queries.length, 0);
      });

      it("returns 401 when REVIEW_TELEMETRY_TOKEN is not in env", async () => {
        const db = createFakeDb();
        const env = { DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=${validUntil}`, {
          method: "GET",
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 401);
        assert.equal(db.queries.length, 0);
      });
    });

    describe("Validation", () => {
      const authHeader = { authorization: `Bearer ${VALID_TOKEN}` };

      it("returns 400 when repository parameter is missing or empty", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        // Missing repository
        const req1 = makeRequest(`/api/accounted-runs?since=${validSince}&until=${validUntil}`, {
          method: "GET",
          headers: authHeader,
        });
        const res1 = await worker.fetch(req1, env);
        assert.equal(res1.status, 400);
        const body1 = await res1.json();
        assert.equal(body1.error, "missing repository");

        // Empty repository
        const req2 = makeRequest(`/api/accounted-runs?repository=&since=${validSince}&until=${validUntil}`, {
          method: "GET",
          headers: authHeader,
        });
        const res2 = await worker.fetch(req2, env);
        assert.equal(res2.status, 400);
        const body2 = await res2.json();
        assert.equal(body2.error, "missing repository");
        assert.equal(db.queries.length, 0);
      });

      it("returns 400 when since parameter is missing", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&until=${validUntil}`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error, "missing since");
        assert.equal(db.queries.length, 0);
      });

      it("returns 400 when until parameter is missing", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error, "missing until");
        assert.equal(db.queries.length, 0);
      });

      it("returns 400 when since is not a valid ISO 8601 UTC timestamp", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const invalidValues = ["not-a-date", "2026-08-30", "2026-08-30T12:00:00+05:00", "2026-08-30T12:00:00"];
        for (const badSince of invalidValues) {
          const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${encodeURIComponent(badSince)}&until=${validUntil}`, {
            method: "GET",
            headers: authHeader,
          });
          const res = await worker.fetch(req, env);
          assert.equal(res.status, 400);
          const body = await res.json();
          assert.equal(body.error, "invalid since");
        }
        assert.equal(db.queries.length, 0);
      });

      it("returns 400 when until is not a valid ISO 8601 UTC timestamp", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=invalid-until-ts`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error, "invalid until");
        assert.equal(db.queries.length, 0);
      });

      it("returns 400 when until precedes since", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validUntil}&until=${validSince}`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error, "invalid window: until precedes since");
        assert.equal(db.queries.length, 0);
      });

      it("returns 400 when window exceeds 30 days", async () => {
        const db = createFakeDb();
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const over30Days = "2026-09-30T00:00:01Z"; // 31 days + 1 sec
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=${over30Days}`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error, "window exceeds 30 days");
        assert.equal(db.queries.length, 0);
      });

      it("accepts a window of exactly 30 days", async () => {
        const db = createFakeDb({
          handler: () => ({ results: [] }),
        });
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const exactly30Days = "2026-09-29T00:00:00Z";
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=${exactly30Days}`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);
        assert.equal(db.queries.length, 1);
      });
    });

    describe("Query & Results", () => {
      const authHeader = { authorization: `Bearer ${VALID_TOKEN}` };

      it("returns union of both tables and no duplicates as JSON array of integers", async () => {
        const db = createFakeDb({
          handler: (sql, args) => {
            return {
              results: [
                { run_id: 1001 },
                { run_id: 1002 },
                { run_id: 1002 }, // Duplicate from lane_events union
                { run_id: 1003 },
              ],
            };
          },
        });
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=${validUntil}`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);
        const data = await res.json();

        assert.equal(data.repository, validRepo);
        assert.equal(data.since, validSince);
        assert.equal(data.until, validUntil);
        assert.deepEqual(data.run_ids, [1001, 1002, 1003]);

        // Verify all elements are integers
        for (const id of data.run_ids) {
          assert.ok(Number.isInteger(id));
        }

        // Verify query bindings respect the window and repository
        assert.equal(db.queries.length, 1);
        const query = db.queries[0];
        assert.ok(query.sql.includes("FROM usage_records"));
        assert.ok(query.sql.includes("FROM lane_events"));
        assert.ok(query.sql.includes("UNION"));
        const expectedSince = new Date(validSince).toISOString();
        const expectedUntil = new Date(validUntil).toISOString();
        assert.deepEqual(query.args, [validRepo, expectedSince, expectedUntil, validRepo, expectedSince, expectedUntil]);
      });

      it("normalizes +00:00 timestamp to Z ISO string in bindings (#87, finding 3944010386)", async () => {
        const db = createFakeDb({
          handler: () => ({ results: [{ run_id: 2001 }] }),
        });
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const zeroOffsetSince = "2026-08-30T00:00:00+00:00";
        const zeroOffsetUntil = "2026-08-31T02:00:00+00:00";
        const req = makeRequest(
          `/api/accounted-runs?repository=${validRepo}&since=${encodeURIComponent(zeroOffsetSince)}&until=${encodeURIComponent(zeroOffsetUntil)}`,
          {
            method: "GET",
            headers: authHeader,
          }
        );
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.deepEqual(data.run_ids, [2001]);

        assert.equal(db.queries.length, 1);
        const query = db.queries[0];
        assert.equal(query.args[1], "2026-08-30T00:00:00.000Z");
        assert.equal(query.args[2], "2026-08-31T02:00:00.000Z");
      });

      it("returns empty run_ids array when neither table has matches", async () => {
        const db = createFakeDb({
          handler: () => ({ results: [] }),
        });
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=${validUntil}`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.repository, validRepo);
        assert.equal(data.since, validSince);
        assert.equal(data.until, validUntil);
        assert.deepEqual(data.run_ids, []);
      });

      it("returns 500 when database throws an error", async () => {
        const db = createFakeDb({ shouldThrow: true });
        const env = { REVIEW_TELEMETRY_TOKEN: VALID_TOKEN, DB: db };
        const req = makeRequest(`/api/accounted-runs?repository=${validRepo}&since=${validSince}&until=${validUntil}`, {
          method: "GET",
          headers: authHeader,
        });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 500);
        const data = await res.json();
        assert.equal(data.error, "database error");
      });
    });
  });
});
