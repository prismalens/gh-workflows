-- Migration 0013: failure classification, an alternative credential, tool metadata,
-- and telemetry for two part-1 slices (gh-workflows#12 part 2, #174). Extended in
-- later commits of the same part; see history for slice 6 and slice 7's columns.
--
-- Slice 5: account/auth/quota failure classification. All four nullable; every
-- existing row has none, and nothing backfills them.
ALTER TABLE usage_records ADD COLUMN failure_class TEXT;
ALTER TABLE usage_records ADD COLUMN failure_retryable INTEGER;
ALTER TABLE usage_records ADD COLUMN failure_reset_at TEXT;
ALTER TABLE usage_records ADD COLUMN api_error_status INTEGER;

-- Slice 6: which credential authenticated this round, 'oauth' or 'api_key'.
ALTER TABLE usage_records ADD COLUMN credential_type TEXT;
