-- Wave 2 telemetry schema additions (#70, #71, #72, #87)
-- All new columns are nullable with no default to maintain backward and forward compatibility.

ALTER TABLE usage_records ADD COLUMN lane_version TEXT;
ALTER TABLE usage_records ADD COLUMN verdict_kind TEXT;
ALTER TABLE usage_records ADD COLUMN verdict_text TEXT;
ALTER TABLE usage_records ADD COLUMN inline_count INTEGER;
ALTER TABLE usage_records ADD COLUMN summary_count INTEGER;
ALTER TABLE usage_records ADD COLUMN comment_node_ids TEXT;
ALTER TABLE usage_records ADD COLUMN fallback_reason TEXT;
ALTER TABLE usage_records ADD COLUMN range_base TEXT;
ALTER TABLE usage_records ADD COLUMN range_head TEXT;
ALTER TABLE usage_records ADD COLUMN model_source TEXT;
ALTER TABLE usage_records ADD COLUMN config_resolution TEXT;
ALTER TABLE usage_records ADD COLUMN job_conclusion TEXT;
ALTER TABLE usage_records ADD COLUMN round_ordinal INTEGER;
ALTER TABLE usage_records ADD COLUMN pr_title TEXT;
ALTER TABLE usage_records ADD COLUMN pr_author TEXT;
ALTER TABLE usage_records ADD COLUMN pr_state TEXT;
ALTER TABLE usage_records ADD COLUMN pr_base_ref TEXT;
ALTER TABLE usage_records ADD COLUMN pr_head_ref TEXT;

CREATE TABLE IF NOT EXISTS lane_events (
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  repository TEXT NOT NULL,
  reason TEXT NOT NULL,
  pr_number INTEGER,
  head_sha TEXT,
  run_url TEXT,
  rounds_used INTEGER,
  lane_version TEXT,
  PRIMARY KEY (run_id, run_attempt)
);
CREATE INDEX IF NOT EXISTS idx_lane_events_repo_time ON lane_events (repository, recorded_at);

CREATE TABLE IF NOT EXISTS canary_pings (
  id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  run_url TEXT,
  lane_version TEXT
);
