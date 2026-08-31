import type { RoundRow } from "@/api/types";

/**
 * Fixtures are derived from worker/migrations/0001_initial_schema.sql and the jq
 * that builds the record in claude-code-review.yml. The live deployment sits
 * behind Access and is not scraped for them.
 */

const REPOSITORIES = ["prismalens/prismalens", "prismalens/sreforge", "Sumit1993/mage-memory"];
const ROUND_TYPES = ["full", "incremental", "verify"];
const MODELS = ["claude-opus-4-6", "claude-sonnet-4-6"];

/** A tiny LCG, because a fixture set that changes between runs cannot be asserted on. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface FixtureOptions {
  count?: number;
  /** The newest round's timestamp. Everything else is spread backwards from it. */
  now?: Date;
  seed?: number;
}

export function makeRounds(options: FixtureOptions = {}): RoundRow[] {
  const { count = 64, now = new Date("2026-08-31T09:00:00.000Z"), seed = 20260831 } = options;
  const random = lcg(seed);
  const rows: RoundRow[] = [];

  for (let i = 0; i < count; i++) {
    // Newest first, thinning out as it goes back: 3 repos at roughly 7 rounds a day.
    const hoursBack = i * 3.5 + Math.floor(random() * 4);
    const recordedAt = new Date(now.getTime() - hoursBack * 3600 * 1000).toISOString();
    const repository = REPOSITORIES[i % REPOSITORIES.length];
    const roundType = ROUND_TYPES[i % ROUND_TYPES.length];
    const model = MODELS[i % MODELS.length];
    const prNumber = 100 + Math.floor(i / 2);
    const runId = 33_000_000_000 + i * 137;

    const inputTokens = 4_000 + Math.floor(random() * 9_000);
    const outputTokens = 1_200 + Math.floor(random() * 5_000);
    const cacheRead = 120_000 + Math.floor(random() * 400_000);
    const cacheCreation = 20_000 + Math.floor(random() * 60_000);
    const durationMs = 90_000 + Math.floor(random() * 420_000);
    const denials = i % 9 === 0 ? 1 + Math.floor(random() * 3) : 0;
    const runAttempt = i % 17 === 0 ? 2 : 1;
    const isError = i % 23 === 0;
    const numTurns = 8 + Math.floor(random() * 30);
    const headSha = (0xabcdef0 + i * 7919).toString(16).padStart(8, "0").repeat(5).slice(0, 40);

    // A verify round is a single-agent prompt, so it carries no fan-out stats.
    const subagentStats =
      roundType === "verify"
        ? null
        : JSON.stringify({
            launched: 4,
            completed: i % 11 === 0 ? 3 : 4,
            failed: i % 11 === 0 ? 1 : 0,
            total_duration_ms: Math.floor(durationMs * 0.72),
          });

    rows.push({
      session_id: `fixture-session-${String(i).padStart(4, "0")}`,
      recorded_at: recordedAt,
      repository,
      pr_number: prNumber,
      pr_url: `https://github.com/${repository}/pull/${prNumber}`,
      head_sha: headSha,
      run_id: runId,
      run_attempt: runAttempt,
      run_url: `https://github.com/${repository}/actions/runs/${runId}`,
      round_type: roundType,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
      total_cost_usd: Number((0.4 + random() * 2.6).toFixed(4)),
      duration_ms: durationMs,
      duration_api_ms: Math.floor(durationMs * (0.55 + random() * 0.3)),
      num_turns: numTurns,
      permission_denials: denials,
      changed_files: 1 + Math.floor(random() * 24),
      diff_lines: 12 + Math.floor(random() * 900),
      lane_version: "v2.0.0",
      verdict_kind: isError ? "error" : "clean",
      inline_count: denials,
      summary_count: isError ? 1 : 0,
      round_ordinal: 1,
      fallback_reason: null,
      range_base: null,
      range_head: null,
      model_source: "workflow-default",
      job_conclusion: isError ? "failure" : "success",
      pr_title: `PR ${prNumber}`,
      pr_author: "developer",
      pr_state: "open",
      pr_base_ref: "main",
      pr_head_ref: `feature-${prNumber}`,
      per_model_usage: JSON.stringify({
        [model]: {
          inputTokens,
          outputTokens,
          cacheReadInputTokens: cacheRead,
          cacheCreationInputTokens: cacheCreation,
          costUSD: Number((0.4 + random() * 2.6).toFixed(4)),
          webSearchRequests: 0,
        },
      }),
      subagent_stats: subagentStats,
      raw_result: JSON.stringify({
        type: "result",
        subtype: isError ? "error_during_execution" : "success",
        session_id: `fixture-session-${String(i).padStart(4, "0")}`,
        uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        is_error: isError,
        stop_reason: isError ? "error" : "end_turn",
        num_turns: numTurns,
        denial_tools:
          denials > 0
            ? [
                { tool: "Bash", count: Math.max(1, denials - 1) },
                { tool: "WebFetch", count: 1 },
              ]
            : [],
      }),
    });
  }

  return rows;
}

/** The full fixture set: 64 rounds, enough to exercise the p95 path at n ≥ 20. */
export const FIXTURE_ROUNDS: RoundRow[] = makeRounds();

/** Nine rounds: the range that must render the table instead of tiles. */
export const SPARSE_FIXTURE_ROUNDS: RoundRow[] = makeRounds({ count: 9, seed: 7 });
