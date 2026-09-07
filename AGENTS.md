# Working in this repository

## Review policy: CodeRabbit only, batched

CodeRabbit reviews this repository and nothing else does. The Claude review lane cannot:
`claude-code-action` self-skips on any pull request that edits
`.github/workflows/claude-code-review.yml`, and this repository hosts that file. That is why
`auto_review` is on in `.coderabbit.yaml` here and off in the consumer repos, where the Claude lane
covers every pull request and CodeRabbit is the escalation.

The `claude-code-action` pin in that workflow file is duplicated at two `uses:` lines (the review
job and the verify job); a version bump must move both together. `uses:` cannot take a `${{ }}`
expression, so the pin cannot be centralized into a single input or env value.

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

CodeRabbit's rate-limit notice states the wait, and that figure is accurate to within 15 seconds
(measured 2026-09-01). Obey it rather than a fixed floor. An earlier session built a confident,
wrong conclusion by doing arithmetic on a circulated 40-minute figure and presenting it as a
measurement; do not repeat that.

`auto_review` is enabled here and there is no separate summon step, so **opening a pull request
spends a slot, and so does a push to an open one while the lane is unpaused**. Batching means
batching before the push, not before a summon: by the time you would summon, the slot is gone.

Measured 2026-09-07, because a peer session argued from the OSS tier's star threshold that
opening a pull request here is free and the summon is what costs. It is not, and the star count
is the wrong thing to read:

| pull request | created | first `coderabbitai[bot]` comment | human summon first? |
| --- | --- | --- | --- |
| #158 | 08:50:53Z | 08:51:03Z | no |
| #155 | 08:03:22Z | 08:04:55Z | no |
| #142 | 16:12:33Z | 16:12:41Z | no; the `@coderabbitai review` came 93 minutes later |

So settle this against comment timestamps on a recent pull request, never against
`stargazerCount`. A lane that trusts the star threshold opens four pull requests believing all
four are free and spends the slot on the first.

**A draft is the exemption, and it is what makes batching practical.** `drafts` defaults to
false under `auto_review`, and this repository does not set it, so opening a draft costs
nothing and neither does any push to it. Measured on #161: CodeRabbit posted "Draft PR not
reviewed" seventeen seconds after the draft was opened, with no review. The slot is spent when
the pull request is marked ready.

So the shape of a batched run is: open the draft first, push to it as often as the work wants,
and mark it ready once, at the end. Nothing is saved by holding commits back before a push to
a draft, which is the opposite of the rule for a pull request that is already ready.

One slot is worth far more than one change. CodeRabbit will take on the order of 150 files in a
single review, so a batch of a dozen issues costs exactly what a typo fix costs. Size the batch
by what reviews together coherently and by what is unblocked, never by what feels like a
reasonable pull request.

### Batch the lanes too, not only the pull request

A batch of a dozen issues is not a dispatch of a dozen lanes. One lane per issue re-reads the
same repository a dozen times, and every one of those reads is paid for.

- **Group issues that share a surface into one lane.** Issues touching the same files, or the
  same subsystem, go out as one brief with a list. A lane that has already read
  `claude-code-review.yml` to fix one thing in it is the cheapest possible place to fix the
  second thing in it.
- **Continue a lane rather than replacing it.** When follow-up work lands on a surface a lane
  already holds, message that lane. It keeps its context, so the second task costs a fraction
  of the first. Spawning a fresh agent for it pays the whole setup cost again for nothing.
- **Split by file ownership, never by issue count.** Two lanes that cannot both edit the same
  file is a real constraint. Two lanes because there happened to be two issue numbers is not.

The exception is a lane that has gone wrong. A confused lane is not made less confused by more
instructions, so start that one over rather than continuing it.

So:

- Land related work as one pull request rather than a chain of small ones.
- Batch every fix before you push. Never spend a slot on a commit you are about to amend.
- Open it as a draft, keep pushing while the work continues, and mark it ready only when the
  last item lands.
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
