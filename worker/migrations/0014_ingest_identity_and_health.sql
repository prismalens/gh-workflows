-- Migration 0014: ingest identity provenance and health reporting (#176).

ALTER TABLE usage_records ADD COLUMN ingest_auth TEXT;
ALTER TABLE usage_records ADD COLUMN repository_id INTEGER;

ALTER TABLE lane_events ADD COLUMN ingest_auth TEXT;
ALTER TABLE lane_events ADD COLUMN repository_id INTEGER;

ALTER TABLE review_findings ADD COLUMN ingest_auth TEXT;
ALTER TABLE review_findings ADD COLUMN repository_id INTEGER;

ALTER TABLE prs ADD COLUMN ingest_auth TEXT;
ALTER TABLE prs ADD COLUMN repository_id INTEGER;

CREATE TABLE health_reports (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  repository_id INTEGER,
  generated_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  workflow_runs INTEGER NOT NULL,
  telemetry_records INTEGER NOT NULL,
  lane_events INTEGER NOT NULL,
  missing_runs INTEGER NOT NULL,
  missing_run_ids TEXT NOT NULL,
  sweep_findings INTEGER NOT NULL,
  pr_state_count INTEGER NOT NULL,
  ingest_auth TEXT NOT NULL,
  report_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_reports_repo_time ON health_reports(repository, generated_at DESC);
