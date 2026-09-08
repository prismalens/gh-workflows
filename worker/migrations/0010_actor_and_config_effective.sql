-- Migration 0010: lane_events.actor (#124) and usage_records.config_effective (#75).
--
-- `actor` is nullable. The lane sets it only on a `paused-by-request` event, from
-- `github.event.comment.user.login`, never from comment text. Every existing row, and
-- every row for any other reason, stays null; there is nothing to backfill it from.
--
-- `config_effective` is a JSON object blob, `{key: {value, layer}}` for every config key
-- the lane resolved on the round, `layer` one of workflow/org/repo/summon. It sits beside
-- `config_resolution` (`config_hash`'s explanation, not its replacement) and is returned
-- only under `include=blobs`, like every other blob column, so an unconditional read never
-- grows the size of a list response.

ALTER TABLE lane_events ADD COLUMN actor TEXT;
ALTER TABLE usage_records ADD COLUMN config_effective TEXT;
