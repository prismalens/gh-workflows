-- Variant identity fields (#47 amendment, 2026-09-02)
-- All new columns are nullable with no default to maintain backward and forward compatibility.

ALTER TABLE usage_records ADD COLUMN prompt_hash TEXT;
ALTER TABLE usage_records ADD COLUMN action_version TEXT;
ALTER TABLE usage_records ADD COLUMN config_hash TEXT;
ALTER TABLE usage_records ADD COLUMN variant TEXT;
ALTER TABLE usage_records ADD COLUMN variant_key TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_variant_key ON usage_records (variant_key);
