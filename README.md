# gh-workflows

Canonical GitHub Actions workflows and composite actions for `prismalens` ecosystem repositories.

## Membership Rule

If a defect fixed in one repo's copy would need the same fix in another's, the file belongs here.

---

## Reusable Lanes (`workflow_call`)

Reusable workflow callees live in `.github/workflows/` and are invoked by consumer repositories via `workflow_call`.

### Callees

- `.github/workflows/claude-code-review.yml`
- `.github/workflows/claude-fix.yml`
- `.github/workflows/claude.yml`
- `.github/workflows/dependabot-auto-merge.yml`

### Worked-Example Consumer Stub (Review Lane)

```yaml
name: Claude Code Review

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, ready_for_review, reopened]
  # Comment triggers carry the `@claude review` summon; the callee decides
  # admission (org member + explicit verb).
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

# This is a managed caller stub.
# The lane logic lives in prismalens/gh-workflows/.github/workflows/claude-code-review.yml.
# Do not add logic here.

# Concurrency lives in the caller ONLY: a callee sharing the caller's group
# deadlocks the run ("deadlock detected for concurrency group").
concurrency:
  group: claude-code-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    # Caller-side draft guard, scoped to automatic rounds: a `@claude review` summon
    # is explicit intent and must reach a draft PR too.
    if: github.event_name != 'pull_request' || github.event.pull_request.draft != true
    uses: prismalens/gh-workflows/.github/workflows/claude-code-review.yml@main
    # explicit mapping is the canon pattern — `inherit` does not cross ownership
    # boundaries and silently fails cross-owner consumers.
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    permissions:
      contents: read
      # write is the ceiling for the callee's `announce` and `fork-notice` jobs;
      # the callee's `review` job self-restricts to read.
      pull-requests: write
      issues: read
      id-token: write
```

The concurrency group key resolves to the PR number on all three events:
`github.event.pull_request.number` covers `pull_request` and
`pull_request_review_comment`, and `github.event.issue.number` covers
`issue_comment`.

### Worked-Example Consumer Stub (Mention Lane)

The mention lane answers bare `@claude` comments. It must stand down on the
verbs the review and fixer lanes own, or every `@claude review` and `@claude fix`
comment fires two lanes on the same PR.

```yaml
name: Claude Code

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]

# This is a managed caller stub.
# The lane logic lives in prismalens/gh-workflows/.github/workflows/claude.yml.
# Do not add logic here.

concurrency:
  group: claude-mention-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  claude:
    # Verb exclusion: the review and fixer lanes own these three phrasings.
    # `@claude full review` does not contain `@claude review` as a substring,
    # so all three checks are needed. `contains()` on a null body is false, so
    # `issues` and `pull_request_review` events pass through untouched.
    if: >-
      !(
        contains(github.event.comment.body, '@claude fix') ||
        contains(github.event.comment.body, '@claude review') ||
        contains(github.event.comment.body, '@claude full review')
      )
    uses: prismalens/gh-workflows/.github/workflows/claude.yml@main
    # explicit mapping is the canon pattern — `inherit` does not cross ownership
    # boundaries and silently fails cross-owner consumers.
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write
      actions: read
```

### Worked-Example Consumer Stub (Fixer Lane)

```yaml
name: Claude Fix

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

# This is a managed caller stub.
# The lane logic lives in prismalens/gh-workflows/.github/workflows/claude-fix.yml.
# Do not add logic here.

concurrency:
  group: claude-fix-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  fix:
    uses: prismalens/gh-workflows/.github/workflows/claude-fix.yml@main
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    permissions:
      contents: write
      pull-requests: read
      issues: read
      id-token: write
```

### Stub Rules

1. **Permissions Union (incl. Announce Write Ceiling)**: Caller stubs declare permissions as the union of permissions needed by the lane logic, capped by the write access ceiling required for posting status comments or reviews.
2. **Concurrency in Caller Only**: Concurrency must be declared at caller level only. A callee sharing the caller's concurrency group deadlocks the run ("deadlock detected for concurrency group").
3. **Secrets Mapped Explicitly**: `secrets: inherit` does not cross repository owners (e.g. across orgs/users like `prismalens` vs `Sumit1993`). Secrets must be mapped explicitly across owner boundaries.
4. **Mention Lane Excludes Owned Verbs**: The `claude.yml` caller stub must carry a caller-level `if:` excluding comment bodies that contain `@claude fix`, `@claude review`, or `@claude full review`. Those verbs belong to the fixer and review lanes; without the exclusion each such comment fires two lanes on the same PR. Exact expression: the Mention Lane worked example above.
5. **Pin `branches` on `pull_request`**: Every stub that triggers on `pull_request` pins `branches: [main]`, so covering a future `release/*` branch is a decision someone makes, not an accident.

### Review lane inputs

Both are optional `workflow_call` inputs on `claude-code-review.yml`; the defaults are the intended posture and a stub only sets them to deviate.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `skip_authors` | string | `dependabot[bot]` | Comma-separated PR author logins whose **automatic** `pull_request` rounds are skipped entirely — no review, no verify, no liveness comment. Matching is exact-login (the list is delimiter-wrapped), so `bot` never collides with `dependabot[bot]`. Use no spaces after the commas. A `@claude review` summon bypasses the list: manual intent wins. |
| `auto_pause_rounds` | number | `3` | Automatic rounds allowed on one PR before the lane pauses itself. The count lives in the liveness comment's marker (`<!-- claude-review-liveness rounds=N -->`); only automatic rounds that actually ran increment it. On pause the lane posts `auto-paused after N automatic rounds` instead of reviewing. Monotonic — v1 never resets it, so a summon resumes for exactly that one run. |

Override example:

```yaml
jobs:
  review:
    uses: prismalens/gh-workflows/.github/workflows/claude-code-review.yml@main
    with:
      skip_authors: 'dependabot[bot],renovate[bot]'
      auto_pause_rounds: 5
```

### Summon grammar

Bare PR comments, org members only (`OWNER`, `MEMBER`, or `COLLABORATOR`). The comment body is read only by workflow `contains()` expressions — it never reaches a prompt.

| Comment | Lane | Behaviour |
| --- | --- | --- |
| `@claude review` | review | Incremental. The lane's own mode detection decides: a verify round if unresolved `claude[bot]` threads exist, otherwise a normal review. |
| `@claude full review` | review | From scratch. Forces a review and instructs it to ignore existing comments and threads as dedup targets — without that the plugin's dedup silently publishes nothing (prismalens/prismalens#410). |
| `@claude fix` | fixer | Applies fixes on the PR branch (`claude-fix.yml`). |
| bare `@claude …` | mention | Anything not matching the verbs above. |

Summons run on draft PRs (explicit intent overrides the draft skip) and always run past the auto-pause counter. Fork-head PRs stay refused even when summoned (v1) — they get the `<!-- claude-review-fork-notice -->` comment instead.

### Verification rounds (incremental re-review)

Pushes to a PR with unresolved `claude[bot]` threads get a verify round (per-thread verdicts + delta-only review + a `## Code review — verification round` summary) instead of a stock re-review; verdicts are judgment only, resolution stays with the operator; design: prismalens/prismalens#403.

### Fork PRs

Fork heads never reach the reviewer: GitHub withholds the repository's secrets from fork code, and this lane deliberately does not use `pull_request_target`. A separate `fork-notice` job upserts a `<!-- claude-review-fork-notice -->` comment saying so and pointing at the `coderabbit_review` label. Fork `pull_request` runs also hold a read-only `GITHUB_TOKEN` unless the repository enables *Send write tokens to workflows from fork pull requests* (off by default); when the comment is denied, the job falls back to a workflow warning annotation carrying the same text.

---

## Composite Actions

### `actions/pr-title`

#### Why `pr-title` is NOT a reusable workflow

The PR title required status check name is pinned in repository rulesets (branch protection rules). Reusable workflows (`workflow_call`) automatically rename check runs to `"caller-job-name / callee-job-name"` (e.g. `validate / Validate PR title`), breaking pinned required status check names in rulesets. Composite actions execute within the caller's job context, keeping the check run name exact.

#### Usage Snippet

```yaml
name: Lint PR title

on:
  pull_request_target:
    types:
      - opened
      - reopened
      - edited
      - synchronize
  merge_group:

permissions:
  pull-requests: read

jobs:
  validate:
    name: Validate PR title (conventional commits)
    runs-on: ubuntu-latest
    steps:
      - if: github.event_name != 'merge_group'
        uses: prismalens/gh-workflows/actions/pr-title@main
        with:
          types: |
            feat
            fix
            docs
            style
            refactor
            perf
            test
            build
            ci
            chore
            revert
      - if: github.event_name == 'merge_group'
        run: echo "Title validated on the pull request before it entered the merge queue."
```

---

## Consumer Repositories

The following consumer repositories use shared CI from this repository (replacing `consumers.json`):

- `prismalens/prismalens`
- `prismalens/sreforge`
- `Sumit1993/mage-memory`

---

## Copy-Sync Retirement

The copy-sync mechanism (`canonical/`, `scripts/sync-consumer.sh`, `scripts/check-drift.sh`, `consumers.json`) is retired. Reusable workflows (`workflow_call`) and composite actions make workflow drift structurally impossible for shared CI lanes across consumer repositories.
