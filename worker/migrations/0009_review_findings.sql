-- Migration 0009: review findings (gh-workflows #47).
-- One row per claude[bot] review thread, fed by a daily per-repo sweep (never gh-workflows
-- itself: it has no Claude lane). Mutable state, not an event: the sweep re-reads a thread on
-- every pass and the ingest route upserts on `thread_node_id`, overwriting every column rather
-- than only filling in nulls, so an edited comment or a newly-resolved thread settles here too.
--
-- `original_line` is the durable key; `line` is null on roughly a third of threads (GitHub nulls
-- it once a later commit moves the file) and is display-only, never keyed on.
-- `fix_sha`/`fix_sha_source` replace the file-level `addressed` classification the first design
-- of this table used (cut for false-positiving on squash merges and non-commit fixes, #47's
-- schema amendment). `fix_sha_source` is one of `verify_table` or `human_reply`; both are
-- checked against real commit oids before they ever reach this column.
-- `header_raw` and `resolved_by_login` are stored verbatim. Neither is enumed or pre-classified
-- here: the human/workflow-actor split lives in dashboard code as a versioned exclusion list, so
-- a later fix to that list re-renders history with no re-sweep.
-- `row_set_incomplete` is not in the ruled schema table. The sweep sets it when a GraphQL
-- throttle stopped its pagination partway through a pull request, so that PR's rows are known
-- partial rather than silently read as a complete sweep.
--
-- No severity column, no `addressed` boolean, no `lane` column: only the Claude lane is ever
-- swept, so nothing here distinguishes lanes, and no CodeRabbit row can land in this table.

CREATE TABLE IF NOT EXISTS review_findings (
  thread_node_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  path TEXT,
  original_line INTEGER,
  line INTEGER,
  is_resolved INTEGER,
  is_outdated INTEGER,
  resolved_by_login TEXT,
  thread_created_at TEXT,
  header_raw TEXT,
  body_excerpt TEXT,
  diff_hunk TEXT,
  human_reply_count INTEGER,
  human_reply_sha TEXT,
  fix_sha TEXT,
  fix_sha_source TEXT,
  verify_verdict TEXT,
  head_sha_reviewed TEXT,
  last_swept_at TEXT,
  row_set_incomplete INTEGER
);

CREATE INDEX IF NOT EXISTS idx_review_findings_repo_pr ON review_findings (repository, pr_number);
