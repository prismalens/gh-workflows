CREATE TABLE IF NOT EXISTS usage_records (
  session_id TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  repository TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT,
  run_id INTEGER,
  run_attempt INTEGER,
  run_url TEXT,
  round_type TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  total_cost_usd REAL,
  duration_ms INTEGER,
  duration_api_ms INTEGER,
  num_turns INTEGER,
  permission_denials INTEGER,
  changed_files INTEGER,
  diff_lines INTEGER,
  per_model_usage TEXT NOT NULL,
  subagent_stats TEXT,
  raw_result TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_repo_time
  ON usage_records (repository, recorded_at);

CREATE INDEX IF NOT EXISTS idx_usage_round_type
  ON usage_records (round_type, recorded_at);

CREATE INDEX IF NOT EXISTS idx_usage_recorded_at
  ON usage_records (recorded_at DESC, session_id DESC);
