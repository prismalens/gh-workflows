-- Migration 0018: GitHub App webhook deliveries, deduped on X-GitHub-Delivery (#184 bullet 4).
--
-- A redelivery carries the same delivery id as the original, so a handled delivery is a
-- no-op. The row is written last, with the outcome's own writes, so a delivery that failed
-- with a 5xx has no row and a manual redelivery reaches the handler again. Rows older than
-- 7 days are deleted on each accepted delivery. 0017 is held by #198.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT,
  repository TEXT,
  pr_number INTEGER,
  outcome TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received ON webhook_deliveries (received_at);
