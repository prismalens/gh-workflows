-- Migration 0012: usage_records.context_repositories and context_lines (#90).
--
-- Cross-repository context: count of public repositories checked out under .claude-context/
-- and total lines read into reviewable_lines. Both nullable; every existing row has
-- neither, and nothing backfills them.

ALTER TABLE usage_records ADD COLUMN context_repositories INTEGER;
ALTER TABLE usage_records ADD COLUMN context_lines INTEGER;
