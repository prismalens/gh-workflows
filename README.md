# gh-workflows

Canonical GitHub Actions workflows and composite actions for `prismalens` ecosystem repositories.

## Membership Rule

If a defect fixed in one repo's copy would need the same fix in another's, the file belongs here.

---

## Reusable Lanes (`workflow_call`)

Reusable workflow callees live in `.github/workflows/` and are invoked by consumer repositories via `workflow_call`.

### Callees

- `.github/workflows/claude-code-review.yml`
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
  # A summon never cancels an in-flight automatic round; it queues behind it.
  # A push still supersedes anything in the group, including a summon.
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

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
      # Optional. Without them the lane still posts its verdict and leaves every
      # thread open, because GITHUB_TOKEN cannot resolve threads. See "Thread resolution".
      AUTOMATION_APP_ID: ${{ secrets.AUTOMATION_APP_ID }}
      AUTOMATION_APP_PRIVATE_KEY: ${{ secrets.AUTOMATION_APP_PRIVATE_KEY }}
    permissions:
      contents: read
      # write is the ceiling for the callee's `announce`, `fork-notice`, and `mutate` jobs;
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
verbs the review lane owns, or every `@claude review` comment fires two lanes on
the same PR.

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
    # Verb exclusion: the review lane owns these two phrasings.
    # `@claude full review` does not contain `@claude review` as a substring,
    # so both checks are needed. `contains()` on a null body is false, so
    # `issues` and `pull_request_review` events pass through untouched.
    # Review bodies stay with the mention lane: no other lane subscribes to pull_request_review.
    if: >-
      !(
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

### Stub Rules

1. **Permissions Union (incl. Announce Write Ceiling)**: Caller stubs declare permissions as the union of permissions needed by the lane logic, capped by the write access ceiling required for posting status comments or reviews.
2. **Concurrency in Caller Only**: Concurrency must be declared at caller level only. A callee sharing the caller's concurrency group deadlocks the run ("deadlock detected for concurrency group").
3. **Secrets Mapped Explicitly**: `secrets: inherit` does not cross repository owners (e.g. across orgs/users like `prismalens` vs `Sumit1993`). Secrets must be mapped explicitly across owner boundaries.
4. **Mention Lane Excludes Owned Verbs**: The `claude.yml` caller stub must carry a caller-level `if:` excluding comment bodies that contain `@claude review` or `@claude full review`. Those verbs belong to the review lane; without the exclusion each such comment fires two lanes on the same PR. Exact expression: the Mention Lane worked example above.
5. **Pin `branches` on `pull_request`**: Every stub that triggers on `pull_request` pins `branches: [main]`, so covering a future `release/*` branch is a decision someone makes, not an accident.
6. **Comment Triggers Need a Concurrency Fallback**: The moment a stub gains `issue_comment` / `pull_request_review_comment` triggers, its concurrency group key must fall back to `github.event.issue.number` — `${{ github.event.pull_request.number || github.event.issue.number }}`. `github.event.pull_request.number` is empty on `issue_comment`, so without the fallback the group collapses to the constant `claude-code-review-`: one global group in which any PR's summon cancels every other PR's in-flight run.
7. **Cancel Automatic Rounds Only**: On a lane that takes both `pull_request` and comment triggers, use `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`: a summon never cancels an in-flight automatic round; it queues behind it. A push still supersedes anything in the group, including a summon.
8. **Admission is effective repository permission, not `author_association`**: Comment events in both lanes are admitted only when the acting account holds `admin` or `write` on the repository, checked live in the `admit` composite action. `author_association` is banned from admission: it is repo-scoped and payload-dependent, and it reported `CONTRIBUTOR` in the webhook for a maintainer whose REST record said `MEMBER`, so replies on `prismalens/prismalens` were never admitted. A failed check is red, never silently open and never silently closed. Story: `prismalens/gh-workflows#20`.

### Review lane inputs

All optional `workflow_call` inputs on `claude-code-review.yml`; the defaults are the intended posture and a stub only sets them to deviate.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `skip_authors` | string | `dependabot[bot]` | Comma-separated PR author logins whose **automatic** `pull_request` rounds are skipped entirely — no review, no verify, no liveness comment. Matching is exact-login (the list is delimiter-wrapped), so `bot` never collides with `dependabot[bot]`. Use no spaces after the commas. A `@claude review` summon bypasses the list: manual intent wins. |
| `auto_pause_rounds` | number | `5` | Automatic rounds allowed on one PR before the lane pauses itself. The count lives in the liveness comment's marker (`<!-- claude-review-liveness rounds=N sha=<head> -->`); only automatic rounds that actually ran increment it. On pause the lane posts `auto-paused after N automatic rounds` instead of reviewing. Monotonic — v1 never resets it, so a summon resumes for exactly that one run. |
| `default_model` | string | `claude-sonnet-5` | Model ID handed to `claude-code-action` as `--model`, for all three review shapes (review, full review, verify). Sonnet is the default deliberately: the review lane is the highest-volume Claude spend across the consumer repos. A single run can deviate with `@claude review --model opus` / `--model sonnet` — an allowlist of two fixed phrases mapped to two pinned IDs, never a value read out of the comment. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription, not by this input. |

## Thread resolution needs a GitHub App

`GITHUB_TOKEN` cannot call `resolveReviewThread`. This is not a permissions misconfiguration: the
`mutate` job's token carries `PullRequests: write` and the mutation is still refused with
`gh: Resource not accessible by integration`. Measured on `prismalens/sreforge#157`; story: #18.

An App token can, but only with **both** `pull-requests: write` and `contents: write`. This is the
counter-intuitive part and it was measured, not assumed:

| Minted permissions | `resolveReviewThread` |
| --- | --- |
| `pull_requests: write` | denied |
| `pull_requests: write` + `metadata: read` | denied |
| `pull_requests: write` + `contents: read` | denied |
| `pull_requests: write` + `issues: write` | denied |
| `pull_requests: write` + `contents: write` | **resolves** |

Each row was run against the same live thread and reproduced twice. So resolving a review thread
costs a token that can also push code. That is the reason the `mutate` job is deterministic shell
with no agent in it: the grant is real, so nothing model-influenced may ever hold this token.

So the `mutate` job takes an optional App credential, `AUTOMATION_APP_ID` and `AUTOMATION_APP_PRIVATE_KEY`,
and mints a short-lived installation token per run.

| State | Reply | Thread | Job |
| --- | --- | --- | --- |
| Credential set, mutation succeeds | posted | resolved | success |
| Credential absent | posted | left open, warning names the missing secrets | success |
| Credential set, mutation denied | posted | left open | **fails** |

The third row is deliberate. Before it existed, a denied mutation printed an error and continued, so
a thread ended up carrying a reply reading `Verified fixed in commit <sha>` while still unresolved,
on a job reporting success. On a repo with `required_review_thread_resolution: true` that reads as
done and blocks the merge, which is the worst of both.

**Setting the App up.** `prismalens-automation` is a shared credential, not a review-lane one. It
holds a superset (Contents RW, Pull requests RW, Issues RW, Actions Read) and **every job narrows it
at mint time** with `create-github-app-token`'s `permission-*` inputs. The `mutate` job mints
`permission-pull-requests: write` and nothing else.

**Never mint it into a job that runs an agent.** `review` is read-only by invariant because it feeds
attacker-influenceable diff text to a model, and the mention lane blocks review submission and
thread resolution for the same reason. The App token belongs only in deterministic, no-agent jobs.

Because the consumer repos do not share an owner (`prismalens` is an org, `Sumit1993/mage-memory` is
a user account), the App is installed once per account and the secrets are set per repo. The App
resolves under its own name, which keeps automated resolution distinguishable from a person's.

The App's replies come from `<app-slug>[bot]`, which the admission gate excludes on both
`user.type != 'Bot'` and the `[bot]` suffix, so the loop guard still holds.


Override example:

```yaml
jobs:
  review:
    uses: prismalens/gh-workflows/.github/workflows/claude-code-review.yml@main
    with:
      skip_authors: 'dependabot[bot],renovate[bot]'
      auto_pause_rounds: 3
      default_model: 'claude-opus-5'
```

### Summon grammar

Bare PR comments, admitted accounts only: the summoning account must hold `admin` or `write` on the repository, checked live by the `admit` action. The comment body is read only by workflow `contains()` expressions — it never reaches a prompt.

| Comment | Lane | Behaviour |
| --- | --- | --- |
| `@claude review` | review | Incremental. The lane's own mode detection decides: a verify round if unresolved `claude[bot]` threads exist, otherwise a normal review. |
| `@claude full review` | review | From scratch. Forces a review and instructs it to ignore existing comments and threads as dedup targets — without that the plugin's dedup silently publishes nothing (prismalens/prismalens#410). |
| `@claude review --model opus` | review | Incremental, on `claude-opus-5` for that run only. `--model sonnet` picks `claude-sonnet-5`. Anything else after `--model` — including `haiku`, which is not offered — is ignored and the run uses `default_model`. The suffix is matched as a whole fixed phrase, so `@claude full review --model opus` does **not** switch models. |
| bare `@claude …` | mention | Anything not matching the verbs above. |

Summons run on draft PRs (explicit intent overrides the draft skip) and always run past the auto-pause counter. Fork-head PRs stay refused even when summoned (v1) — they get the `<!-- claude-review-fork-notice -->` comment instead.

### The liveness marker's `sha=` field

The marker is `<!-- claude-review-liveness rounds=N sha=<40-hex> -->`. `sha=` records the last head on which the lane actually **published** review output, and it advances on posted evidence only — never on a green job result, because a run that finished having posted nothing must not move the baseline past commits no reviewer read (prismalens/prismalens#410). The field is omitted entirely when there is no baseline, so its absence is unambiguous: either no review has ever posted on this PR, or the marker predates the field. It is groundwork for a future incremental review range and nothing consumes it yet.

Both fields change from round to round, so **anything matching this comment matches the prefix `<!-- claude-review-liveness`, never the whole string.**

### Verification rounds (incremental re-review)

Replies from a non-bot account to unresolved `claude[bot]` threads trigger a verify round (per-thread verdicts, automated thread resolution via `resolveReviewThread`, delta-only review, and a `## Code review — verification round` summary).

### Fork PRs

Fork heads never reach the reviewer: GitHub withholds the repository's secrets from fork code, and this lane deliberately does not use `pull_request_target`. A separate `fork-notice` job upserts a `<!-- claude-review-fork-notice -->` comment saying so and pointing at the `coderabbit_review` label. Fork `pull_request` runs also hold a read-only `GITHUB_TOKEN` unless the repository enables *Send write tokens to workflows from fork pull requests* (off by default); when the comment is denied, the job falls back to a workflow warning annotation carrying the same text.

---

## Composite Actions

### `actions/admit`

Decides whether an account may start an agent run in this repository. Admits on effective repository permission of `admin` or `write`, checked live against the GitHub collaborators API. Never reads `author_association`.

#### What it takes

- `login` (required): The account that performed the triggering action.
- `token` (required): Token used for the permission lookup.

#### What it returns

- `admitted`: `"true"` when the login holds `admin` or `write` on this repository; `"false"` on quiet refusal.

#### Three outcomes

- **Admit (`admitted=true`, exit 0)**: The account holds `admin` or `write` permission on the repository.
- **Quiet refusal (`admitted=false`, exit 0)**: The account has permission `read` or `none`, returns HTTP 404 (outsider), or is empty / a bot account (`*[bot]`). Emits a notice and stays green so stray comments do not turn PR checks red.
- **Red (`exit 1`)**: Any API failure or unexpected error. Fails loudly with `::error::` so checks never fail open and never fail silently closed.

#### Usage Snippet

```yaml
      - name: Admit commenter
        id: admit
        uses: prismalens/gh-workflows/.github/actions/admit@main
        with:
          login: ${{ github.event.comment.user.login }}
          token: ${{ github.token }}
```

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
