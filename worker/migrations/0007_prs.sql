-- Migration 0007: Pull request current state (gh-workflows #136).
-- `prs` stores the current state and facts about pull requests, decoupled from round snapshots.
-- `updated_at` is when we last learned something, `source` is how we learned it: `round`, `hook`, or `reconciler`.
-- Both are required: a row that cannot say when or how it was learned is the same failure this issue is about.
-- The five snapshot columns on `usage_records` (pr_state, pr_title, pr_author, pr_base_ref, pr_head_ref)
-- are deliberately preserved without alteration: they represent the historical record of what each round saw,
-- which is a legitimately different fact from what is true now.

CREATE TABLE IF NOT EXISTS prs (
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  state TEXT,
  title TEXT,
  author TEXT,
  base_ref TEXT,
  head_ref TEXT,
  head_sha TEXT,
  merged_at TEXT,
  closed_at TEXT,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (repository, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_prs_state ON prs (state);
