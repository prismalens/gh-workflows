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

-- Slice 7: per-agent tool call detail (read/grep/glob/bash breakdowns) and how many
-- tool calls touched the harness's own files rather than the checkout.
ALTER TABLE round_agents ADD COLUMN tool_detail TEXT;
ALTER TABLE round_agents ADD COLUMN harness_paths_count INTEGER;

-- Slice 7: telemetry for part 1's slices #90/#162, so a restack skip rate and
-- unmerged-base-PR rate can both be computed from usage_records.
ALTER TABLE usage_records ADD COLUMN base_pr_number INTEGER;
ALTER TABLE usage_records ADD COLUMN patch_fingerprint TEXT;
