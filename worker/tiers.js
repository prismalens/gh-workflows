// The one tier map (#183). Every column of a tiered table sits in exactly one tier, by
// what it can identify: counts (nothing on its own), rounds (a repository, a pull
// request, a run), text (words a person wrote, or a login). A sender's share_level
// says the highest tier it allows, and ingest stores nothing above it. Pinned
// against the migrations by the "tier map" Worker test, so a new column must be
// placed here before it can be written. Ruling: #183 comment 5787138299.

export const SHARE_LEVELS = Object.freeze(["counts", "rounds", "full"]);

// `counts` stores pseudonymous keys, which waits on the operator's answer on #183.
// Until then the Worker refuses it rather than storing a clear key under it.
export const ACCEPTED_SHARE_LEVELS = Object.freeze(["rounds", "full"]);

export const TIERS = Object.freeze({
  usage_records: {
    counts: [
      "session_id",
      "recorded_at",
      "repository",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_cost_usd",
      "duration_ms",
      "duration_api_ms",
      "num_turns",
      "permission_denials",
      "changed_files",
      "diff_lines",
      "per_model_usage",
      "lane_version",
      "verdict_kind",
      "inline_count",
      "summary_count",
      "fallback_reason",
      "model_source",
      "job_conclusion",
      "prompt_hash",
      "action_version",
      "config_hash",
      "variant",
      "variant_key",
      "agents_status",
      "reviewable_lines",
      "size_override",
      "level",
      "level_source",
      "context_repositories",
      "context_lines",
      "failure_class",
      "failure_retryable",
      "failure_reset_at",
      "api_error_status",
      "credential_type",
      "engine",
      "ingest_auth",
      "share_level",
    ],
    rounds: [
      "pr_number",
      "pr_url",
      "head_sha",
      "run_id",
      "run_attempt",
      "run_url",
      "round_type",
      "round_ordinal",
      "comment_node_ids",
      "range_base",
      "range_head",
      "config_resolution",
      "config_effective",
      "pr_state",
      "base_pr_number",
      "patch_fingerprint",
      "subagent_stats",
      "repository_id",
    ],
    text: ["pr_title", "pr_author", "verdict_text", "raw_result", "pr_base_ref", "pr_head_ref"],
  },
  lane_events: {
    counts: [
      "run_id",
      "run_attempt",
      "recorded_at",
      "repository",
      "reason",
      "rounds_used",
      "lane_version",
      "reviewable_lines",
      "max_reviewable_lines",
      "ingest_auth",
      "share_level",
    ],
    rounds: ["pr_number", "head_sha", "run_url", "repository_id"],
    text: ["actor"],
  },
  review_findings: {
    counts: [
      "thread_node_id",
      "repository",
      "pr_number",
      "is_resolved",
      "is_outdated",
      "thread_created_at",
      "human_reply_count",
      "fix_sha_source",
      "verify_verdict",
      "last_swept_at",
      "row_set_incomplete",
      "ingest_auth",
      "share_level",
    ],
    rounds: ["path", "original_line", "line", "human_reply_sha", "fix_sha", "head_sha_reviewed", "repository_id"],
    text: ["resolved_by_login", "header_raw", "body_excerpt", "diff_hunk"],
  },
  prs: {
    counts: [],
    rounds: [
      "repository",
      "pr_number",
      "state",
      "base_ref",
      "head_ref",
      "head_sha",
      "merged_at",
      "closed_at",
      "updated_at",
      "source",
      "ingest_auth",
      "repository_id",
      "share_level",
    ],
    text: ["title", "author"],
  },
  round_agents: {
    counts: [],
    rounds: [
      "session_id",
      "agent_id",
      "subagent_type",
      "spawn_depth",
      "status",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "duration_ms",
      "tool_uses",
      "tool_uses_by_name",
      "file_paths",
      "tool_detail",
      "harness_paths_count",
      "engine",
    ],
    text: [],
  },
});

// Absent means `full`: a lane pinned at a ref older than #183 sends no share_level
// and has always meant full. `off` is never sent, so receiving it is a sender bug.
export function parseShareLevel(value) {
  if (value === undefined || value === null) return { level: "full" };
  if (typeof value === "string" && ACCEPTED_SHARE_LEVELS.includes(value)) return { level: value };
  return { error: "invalid share_level" };
}

// A copy of `record` with every field above `level` set to null, for the given table.
export function stripToLevel(table, level, record) {
  const tiers = TIERS[table];
  const out = { ...record };
  if (level !== "full") {
    for (const column of tiers.text) out[column] = null;
  }
  if (level === "counts") {
    for (const column of tiers.rounds) out[column] = null;
  }
  return out;
}
