-- Rollup outcome beside the rollup (#93 review round).
-- `agents: []` alone cannot distinguish "the rollup failed" from "the round spawned no
-- agents", and #89 needs that distinction. Nullable, no default, no backfill: every row
-- written before this lands has an unknown status and must not claim `ok`.

ALTER TABLE usage_records ADD COLUMN agents_status TEXT;
