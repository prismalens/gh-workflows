-- Migration 0019: the poster and the two runner verdicts (#184).
-- post_outcome: what the poster did with a finished round (posted, did-not-post: <why>, post-failed: <why>).
-- events_from_seq: a credential-cooldown requeue starts a new attempt; only events after this seq are its own.
-- no_runner_at: when the no-runner verdict was recorded for a queued job, so it is recorded once.
ALTER TABLE jobs ADD COLUMN post_outcome TEXT;
ALTER TABLE jobs ADD COLUMN events_from_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN no_runner_at TEXT;
