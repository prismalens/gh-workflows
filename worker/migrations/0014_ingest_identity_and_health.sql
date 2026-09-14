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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  repository_id INTEGER,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  runs_seen INTEGER NOT NULL,
  runs_accounted INTEGER NOT NULL,
  unaccounted_runs TEXT NOT NULL,
  startup_failures INTEGER NOT NULL,
  lane_events_by_reason TEXT NOT NULL,
  findings_swept INTEGER NOT NULL,
  share TEXT NOT NULL,
  ingest_auth TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_health_reports_repo_time ON health_reports(repository, received_at DESC);
