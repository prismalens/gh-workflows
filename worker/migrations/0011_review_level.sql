-- Migration 0011: usage_records.level and level_source (#101).
--
-- Review effort level, orthogonal to model: how many independent passes and whether
-- each finding is separately validated, never which code gets reviewed. Both nullable;
-- every existing row has neither, and nothing backfills them.
--
-- Not enumed here. `low` is schema-rejected in the workflow for this release, not the
-- worker, so enabling it later needs no worker-side change or migration.

ALTER TABLE usage_records ADD COLUMN level TEXT;
ALTER TABLE usage_records ADD COLUMN level_source TEXT;
