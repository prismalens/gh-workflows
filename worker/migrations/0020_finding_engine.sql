-- Migration 0020: which engine wrote a finding (#184). NULL is the Actions lane (claude[bot]);
-- a runner round's finding carries its engine, read from the marker worker/poster.js stamps.
ALTER TABLE review_findings ADD COLUMN engine TEXT;
-- The thread's opening comment URL, so a finding links to its thread (#185). NULL before this sweep.
ALTER TABLE review_findings ADD COLUMN thread_url TEXT;
