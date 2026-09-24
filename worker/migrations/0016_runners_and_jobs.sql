-- Migration 0016: the control plane's runners and jobs (#184 bullet 2), and which engine ran a round.
ALTER TABLE usage_records ADD COLUMN engine TEXT;
ALTER TABLE round_agents ADD COLUMN engine TEXT;

CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  placement TEXT
);

CREATE TABLE runner_credentials (
  runner_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  credential_kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  concurrency INTEGER NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (runner_id, engine, credential_kind)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  mode TEXT NOT NULL,
  level TEXT NOT NULL,
  model TEXT,
  engine TEXT NOT NULL,
  credential_kind TEXT NOT NULL,
  config_effective TEXT,
  state TEXT NOT NULL,
  runner_id TEXT,
  credential_fingerprint TEXT,
  installation_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  leased_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT,
  conclusion TEXT,
  failure_class TEXT,
  reset_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs (state, engine, credential_kind, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_pr ON jobs (repository, pr_number, state);

CREATE TABLE job_events (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
