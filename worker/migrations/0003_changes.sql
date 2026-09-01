-- `at` is when the change landed (the comparison anchor).
-- `created_at` is when the row was written into this registry.

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  at TEXT NOT NULL,
  source_url TEXT,
  scope TEXT NOT NULL,
  repository TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_at ON changes (at DESC);
