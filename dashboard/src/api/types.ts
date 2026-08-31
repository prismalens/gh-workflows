/**
 * Every field here is a column of `usage_records` in worker/migrations/0001_initial_schema.sql,
 * returned verbatim by GET /api/runs. Nothing may be added that the Worker does not send.
 */
export interface RoundRow {
  session_id: string;
  recorded_at: string;
  repository: string;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  run_id: number | null;
  run_attempt: number | null;
  run_url: string | null;
  round_type: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  num_turns: number | null;
  permission_denials: number | null;
  changed_files: number | null;
  diff_lines: number | null;
  /** Only present when the request passed include=blobs. */
  per_model_usage?: string | null;
  subagent_stats?: string | null;
  raw_result?: string | null;
}

export interface RunsResponse {
  rows: RoundRow[];
  next_cursor: string | null;
}

export interface SummaryResponse {
  rows: number;
  repositories: string[];
  wall_clock_ms: { mean: number | null; p95: number | null };
  denials_per_run: number | null;
  cache_hit_rate: number | null;
  caching_multiplier: number | null;
  total_cost_usd: number | null;
  first_recorded_at: string | null;
  last_recorded_at: string | null;
}

/** One entry of the `modelUsage` map the review lane serialises into per_model_usage. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  webSearchRequests?: number;
  contextWindow?: number;
}

/**
 * claude-code-review.yml strips every model-authored string out of raw_result and
 * appends denial_tools. Only the fields it explicitly keeps are typed here.
 */
export interface RawResult {
  type?: string | null;
  subtype?: string | null;
  session_id?: string | null;
  uuid?: string | null;
  stop_reason?: string | null;
  terminal_reason?: string | null;
  api_error_status?: string | null;
  fast_mode_state?: string | null;
  is_error?: boolean | null;
  denial_tools?: Array<{ tool: string; count: number }>;
  [key: string]: unknown;
}
