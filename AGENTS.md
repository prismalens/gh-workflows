# Working in this repository

## Review policy: CodeRabbit only, batched

CodeRabbit reviews this repository and nothing else does. The Claude review lane cannot:
`claude-code-action` self-skips on any pull request that edits
`.github/workflows/claude-code-review.yml`, and this repository hosts that file. That is why
`auto_review` is on in `.coderabbit.yaml` here and off in the consumer repos, where the Claude lane
covers every pull request and CodeRabbit is the escalation.

### Do not dispatch a model review pass as a substitute

Not Opus, not a subagent, not `/code-review`. The `path_instructions` in `.coderabbit.yaml` are the
only channel that carries this repository's invariants into a review, and no model pass can read
them. A reviewer that cannot see the invariants cannot check them, so its approval says nothing
about the thing most likely to break. Use model passes to find bugs if you want, but never in place
of the CodeRabbit review, and never describe one as a review of this repository.

### Batch work into fewer, larger pull requests

CodeRabbit reviews once per pull request, because `auto_pause_after_reviewed_commits: 1` pauses the
lane after the first reviewed commit. Review slots come from an org-wide counter shared across every
repository, session and subagent. One review covering four changes is worth four times a review
covering one.

How long that counter takes to reset is **not settled**. The figure "roughly 40 minutes" circulates
with no recorded measurement behind it, observation since suggests nearer an hour, and
`watch-coderabbit.sh` waits 60 minutes before retrying. Budget an hour and confirm acceptance rather
than trusting any of those numbers. A session recently built a confident, wrong conclusion by doing
arithmetic on the 40-minute figure and presenting it as a measurement; do not repeat that.

`auto_review` is enabled here and there is no separate summon step, so **opening a pull request
spends a slot, and so does a push to an open one while the lane is unpaused**. Batching means
batching before the push, not before a summon: by the time you would summon, the slot is gone.

So:

- Land related work as one pull request rather than a chain of small ones.
- Batch every fix before you push. Never spend a slot on a commit you are about to amend.
- A push auto-pauses the lane. Once all fixes are in, re-request with a bare
  `@coderabbitai review`.

### A rate-limited review check passes by design

When the counter is exhausted the CodeRabbit check reports success with "Review rate limited". That
green check means no review ran. Silence is not a clean review. Read the check text before treating
a pull request as reviewed.

### Declining a finding

State the disposition in the thread with your reasons, wait for the counter-reply, then resolve.
CodeRabbit withdraws findings it accepts are wrong. Do not resolve a thread before it has answered.

## Nothing here is enforced by the platform

This repository is unprotected, verified 2026-08-31 by two probes that cover different mechanisms.
Both are needed, because GitHub protects a branch in two unrelated ways and each endpoint is blind
to the other:

- `repos/prismalens/gh-workflows/rulesets` returns `[]`, both bare and with
  `includes_parents=true` set explicitly. That parameter is what pulls in inherited organization
  rulesets, so the empty array rules those out too.
- `repos/prismalens/gh-workflows/branches/main/protection` returns 404 with the body
  `{"message": "Branch not protected"}`, which rules out classic branch protection.

So no required check blocks a merge, and no gate stops a pull request with unresolved review
threads. Holding a pull request for the operator is the only gate there is, so treat it as one:
never merge and never enable auto-merge unless the operator says so on that pull request.

**Neither probe is sufficient alone, which is what the earlier wording got wrong in both
directions.** Every consumer repo returns 404 on the classic endpoint while being protected by
rulesets, so citing the 404 by itself proves nothing. An empty `rulesets` by itself proves nothing
either, for the mirror-image reason. Run both, and quote both.

A reviewer whose token lacks admin scope gets HTTP 403 rather than 404 from the protection
endpoint and cannot reproduce this. A 403 is "not allowed to look", never "nothing is there".

## Pull request titles

Conventional commit style, checked by `actions/pr-title`: `feat`, `fix`, `docs`, `style`,
`refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
