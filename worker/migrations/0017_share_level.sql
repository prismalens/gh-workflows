-- Migration 0017: the share level each row was written at (#183).
--
-- A row never holds more than its share_level says: ingest strips every field above the
-- sender's level, and the purge lowers the level as it nulls a tier. Existing rows were
-- all written at full, which is what the default backfills. 0016 is held by #196, which
-- is open, and applies in either order: wrangler applies every file d1_migrations lacks.

ALTER TABLE usage_records ADD COLUMN share_level TEXT NOT NULL DEFAULT 'full';
ALTER TABLE lane_events ADD COLUMN share_level TEXT NOT NULL DEFAULT 'full';
ALTER TABLE review_findings ADD COLUMN share_level TEXT NOT NULL DEFAULT 'full';
ALTER TABLE prs ADD COLUMN share_level TEXT NOT NULL DEFAULT 'full';
