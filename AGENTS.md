# Working in this repository

How CodeRabbit spends and pauses is the `coderabbit-lane` skill. This file holds only what is
true of this repository.

## CodeRabbit is the only reviewer

`claude-code-action` self-skips on any pull request that edits
`.github/workflows/claude-code-review.yml`, and this repository hosts that file. So
`auto_review` is on in `.coderabbit.yaml` here, and off in the consumer repos, where the Claude
lane covers every pull request.

Never run a model pass in place of that review. Opus, a subagent and `/code-review` cannot read
the `path_instructions` in `.coderabbit.yaml`, which carry this repository's invariants.

Opening a non-draft pull request spends a review slot, and so does marking a draft ready.
Measured on #142, #155, #158 (bot comment within 93 seconds, no summon) and #161 (draft skipped).
So open a draft, push to it freely, and mark it ready once.

## Pins that move together

- The `claude-code-action` pin sits on two `uses:` lines in `claude-code-review.yml`, the
  review job and the verify job. `uses:` takes no expression, so it cannot be centralized.
  `tests/test-action-version-drift.py` fails when `env.ACTION_VERSION` disagrees with them.
- The actionlint version and checksum sit in `tests.yml` and `claude-code-review.yml`.
  `tests/test-actionlint-pin-drift.py` fails when they disagree (#163).

## What the platform enforces

Verified 2026-09-13. The `main protection` ruleset (id 22383257, active since 2026-09-06)
requires a pull request, squash merges only, linear history, and resolved review threads. It
blocks deletion and force pushes. It has no required status checks and no up-to-date rule, so a
red or stale branch can still merge (#130).

```bash
gh api repos/prismalens/gh-workflows/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
gh api repos/prismalens/gh-workflows/rulesets/22383257 --jq '[.rules[].type]'
```

`branches/main/protection` returns 404 here because the protection is a ruleset, so that
endpoint alone proves nothing. A 403 from either endpoint means the token cannot look.

Never merge or enable auto-merge unless the operator says so on that pull request.

## A callee permission is a caller change

A reusable workflow can only downgrade the token its caller passes. A permission added to a job
in any `workflow_call` callee here ships in every consumer stub before or with the callee.
#161 skipped that, and every consumer's review lane hit `startup_failure` for five days (#165):

```
The nested job 'review' is requesting 'actions: read, checks: read', but is only allowed 'actions: none, checks: none'.
```

A `startup_failure` starts no job, so telemetry never sees it. Only `ci-failure-report.yml`
reports it (#169).

## Pull request titles

Conventional commits, checked by `actions/pr-title`: `feat`, `fix`, `docs`, `style`,
`refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
