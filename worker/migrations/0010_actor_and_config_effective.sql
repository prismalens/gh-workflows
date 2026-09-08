-- Migration 0010: lane_events.actor (#124) and usage_records.config_effective (#75).
--
-- `actor` is nullable. The lane sets it only on a `paused-by-request` event, from
-- `github.event.comment.user.login`, never from comment text. Every existing row, and
-- every row for any other reason, stays null; there is nothing to backfill it from.

ALTER TABLE lane_events ADD COLUMN actor TEXT;
