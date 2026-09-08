-- Migration 0008: review manifest fields (gh-workflows #105).
-- `reviewable_lines` is the new unit: additions plus modified hunk lines, after the
-- by-status table and path filters. `diff_lines` keeps its existing raw meaning.
-- `size_override` (usage_records) marks a round that would have exceeded
-- `max_reviewable_lines` but ran anyway because `@claude full review` asked for it.
-- `reviewable_lines`/`max_reviewable_lines` on `lane_events` carry the same two
-- numbers for a `refused-size` round, which never reaches `usage_records` because
-- it never runs the reviewer.

ALTER TABLE usage_records ADD COLUMN reviewable_lines INTEGER;
ALTER TABLE usage_records ADD COLUMN size_override INTEGER;

ALTER TABLE lane_events ADD COLUMN reviewable_lines INTEGER;
ALTER TABLE lane_events ADD COLUMN max_reviewable_lines INTEGER;
