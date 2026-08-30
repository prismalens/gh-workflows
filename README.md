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
    permissions:
      # Ceilings only. Every callee job declares its own narrower subset.
      # `mutate` needs `contents: write` to resolve threads with GITHUB_TOKEN.
      contents: write
      # `announce`, `fork-notice` and `mutate` post; the rest read.
      pull-requests: write
      issues: read
      # Consumed by `review` alone, to mint its `claude[bot]` token. `verify`
      # declares no `id-token` and tripwires on it. See "Thread resolution".
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
| `auto_pause_rounds` | number | `5` | Automatic rounds allowed on one PR before the lane pauses itself. The count lives in the liveness comment's marker (`<!-- claude-review-liveness rounds=N sha=<head> -->`); only automatic rounds that actually ran increment it. On pause the lane posts `auto-paused after N automatic rounds` instead of reviewing. A `@claude review` summon that **posts review output** resumes the lane and resets the counter to 0; a summon that finished green having posted nothing is not a resume and leaves the count untouched. |
| `default_model` | string | `claude-sonnet-5` | Model ID handed to `claude-code-action` as `--model`, for all three review shapes (review, full review, verify). Sonnet is the default deliberately: the review lane is the highest-volume Claude spend across the consumer repos. A single run can deviate with `--model <alias>` in a summon, choosing from the `model_aliases` allowlist. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription, not by this input. |
| `model_aliases` | string | `opus=claude-opus-5,sonnet=claude-sonnet-5` | Comma-separated `alias=model-id` pairs selectable with `--model <alias>` in a summon. The alias is matched against the comment; the ID is emitted from this list and is never read out of the comment. An alias absent here is not selectable. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription, not by this input. |
| `display_report` | boolean | `false` | Render the review round's reasoning and token/cost usage into the Actions Step Summary (opt-in; set `display_report: true` in the stub to turn on). The summary is world-readable on a public repository; the content is Claude-authored text derived from the pull request diff, which is already public there. When the execution file is missing, empty, or unparseable, the step warns and does not fail the job. |

### Setting inputs per repository

The only mechanism today is a `with:` block on the `uses:` line in the caller stub. There is no configuration file, no repository-level UI, and no validation of what a stub passes. Every consumer therefore runs the callee's defaults unless its own stub overrides them, and today none of them override anything. A per-repo configuration file is tracked as issue #33, and until it lands, changing a knob for one repository means editing that repository's stub.

```yaml
  review:
    uses: prismalens/gh-workflows/.github/workflows/claude-code-review.yml@main
    with:
      display_report: true
      auto_pause_rounds: 3
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Summon grammar

Bare PR comments, admitted accounts only: the summoning account must hold `admin` or `write` on the repository, checked live by the `admit` action. The comment body is read only by workflow `contains()` expressions and alias matching — it never reaches a prompt.

| Comment | Lane | Behaviour |
| --- | --- | --- |
| `@claude review` | review | Incremental. A verify round still wins when unresolved `claude[bot]` threads exist. Otherwise the round is scoped to the commits since the last round that posted review output, read from the `sha=` field of the liveness marker. On a head that has already been reviewed with no open threads, the summon gives a full review rather than doing nothing. |
| `@claude full review` | review | From scratch. Forces a review and instructs it to ignore existing comments and threads as dedup targets — without that the plugin's dedup silently publishes nothing (prismalens/prismalens#410). |
| `@claude review --model <alias>` / `@claude full review --model <alias>` | review | Runs that review shape on the model ID mapped to `<alias>` in `model_aliases` (default `opus=claude-opus-5,sonnet=claude-sonnet-5`). An unrecognized alias falls back to `default_model` and emits a warning annotation. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription. |
| bare `@claude …` | mention | Anything not matching the verbs above. |

Summons run on draft PRs (explicit intent overrides the draft skip) and reset the auto-pause counter to 0, but only when the round actually posted review output — the same evidence that advances `sha=`. Fork-head PRs stay refused even when summoned (v1) — they get the `<!-- claude-review-fork-notice -->` comment instead.

### Incremental review

The baseline is the `sha=` in `<!-- claude-review-liveness rounds=N sha=<head> -->`, and it advances only on a round that posted review output. A verify round never advances it.

The range is computed with `gh api repos/OWNER/REPO/compare/BASE...HEAD`, not git: the checkout is `fetch-depth: 1` and on `pull_request` it is the merge ref, so a local diff would be both impossible and wrong. The compare payload is staged in `.claude-incremental-range.json` for the review agent.

Six conditions fall back to a full review, each logged by name: `no-baseline`, `identical-summon`, `baseline-gone` (the compare 404 after a force-push), `diverged` (which also covers `behind`), `range-too-large` (>= 300 files), and `unexpected-status-<status>`.

An automatic round on a head with no new commits skips, and the liveness comment says so rather than reporting a review.

An incremental round's summary comment is headed `## Code review — incremental (<base>..<head>)` with 7-character short SHAs, and it still begins with the literal `## Code review` because the liveness evidence filter matches on that prefix.

### Step Summary review report

When `display_report` is `true` (opt-in; defaults to `false`), the review lane renders a structured report of the review round directly into the Actions Step Summary:

- **Context Table**: Pull request number, repository, head SHA (short), review round type (`review`, `review-full`, `incremental`), model ID, GitHub run ID, and session ID.
- **Usage Table**: Aggregates token usage (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), total cost in USD (`total_cost_usd`), run duration (`duration_ms`), turn count (`num_turns`), and permission denials (`permission_denials`).
- **Reasoning**: Renders the assistant's text reasoning turns directly as Markdown.

The output is capped at 1,000,000 bytes to stay within GitHub's 1 MiB Step Summary limit. When the execution file is missing, empty, or fails to parse as JSON, the step emits a warning annotation and exits cleanly (exit 0) without failing the review job.

### Advisory liveness comment

The `announce` job upserts an advisory comment on the pull request timeline matching `<!-- claude-review-liveness rounds=N sha=<head> -->` to report review status and prevent silent review failures.

- **Round counter (`rounds=N`)**: Increments only on automatic `pull_request` runs that actually executed and succeeded. Paused, cancelled, failed, or token-less runs do not increment it. An explicit `@claude review` summon that posts review output resets `rounds` to 0.
- **Head baseline (`sha=<head>`)**: Advances to the current PR head only when the review round produces posted review output.
- **Inline comment counting**: The liveness marker counts inline review comments left by `claude[bot]`. The count strictly matches `original_commit_id == HEAD_SHA` (the commit against which the comment was originally created). It avoids `commit_id`, which GitHub automatically rewrites forward as new commits are pushed to the PR. Carried-forward comments from prior heads are therefore never counted as work performed during the current round, preventing stale comments from advancing the baseline or resetting the auto-pause limit.
- **Summary comments**: Filters `claude[bot]` issue comments created since run start with the `## Code review` heading prefix.

## Thread resolution

`resolveReviewThread` costs `contents: write`. It is refused at `contents: read`, which is the
counter-intuitive part and was measured, not assumed: `prismalens/sreforge#157` for the denial,
run `33006099680` for the working case. So a token that can resolve a review thread can also push
code.

`GITHUB_TOKEN` carries it, given the grant. The `mutate` job declares `contents: write` and
`pull-requests: write` and resolves threads directly; no separately configured GitHub App or App
secrets are required. (`GITHUB_TOKEN` is itself an installation token for the GitHub Actions app,
so this drops the *configured* App, not the App-backed token model.) Canary: run `33200877365` resolved a thread on a repo that never held App
credentials. Story: #18, #20.

Because that token can push, **`mutate` runs no agent.** It is deterministic shell rendering
bounded, re-derived fields from the verify round's structured verdicts. Nothing model-influenced
ever holds it.

| State | Reply | Thread | Job |
| --- | --- | --- | --- |
| Verdict `fixed`, mutation succeeds | posted | resolved | success |
| Verdict `still_applies` | posted | left open | success |
| Mutation denied | posted | left open | **fails** |

The last row is deliberate. Before it existed, a denied mutation printed an error and continued, so
a thread ended up carrying a reply reading `Verified fixed in commit <sha>` while still unresolved,
on a job reporting success. On a repo with `required_review_thread_resolution: true` that reads as
done and blocks the merge, which is the worst of both.

### What the `review` job's token can do

The `review` job is **not** read-only, and describing it that way hides where the wall actually is.
It declares `id-token: write`, the sole input to the `claude[bot]` App-token mint: the action calls
`core.getIDToken()` and exchanges the result for a token carrying `contents: write`,
`pull_requests: write` and `issues: write`. The job is write-capable by construction, because
publishing a review needs it.

**The wall is the tool allowlist.** What keeps that capability away from thread resolution and code
push is which tools the agent may call, not which permissions the job holds. `Bash(gh pr review:*)`
is absent from it deliberately. Widening the allowlist is a security change, not a tuning edit.

It is the primary control, not the only one, and the diff text it reasons over is
attacker-influenceable, so the others are worth naming: the job's own `GITHUB_TOKEN` is capped at
`contents: read` and `issues: read`; the prompt forbids resolving threads, submitting a formal
review, and merging; and `mutate` re-gates every verdict against a schema rather than trusting the
model's output shape. None of those is a substitute for the allowlist. Together they are why a
prompt-injection win is bounded rather than fatal.

The `verify` job is the opposite and deliberately so: no `id-token`, a read-only `GITHUB_TOKEN`, and
a tripwire. That is why the allowlist is described below as `verify`'s *third* line rather than its
wall. Two stronger lines sit in front of it there. In `review` no such lines exist, so the allowlist
carries the weight alone. Same mechanism, different job, different load.

### Verification rounds (incremental re-review)

Replies from a non-bot account to unresolved `claude[bot]` threads trigger a verify round: one verdict per open thread, then automated resolution via `resolveReviewThread`, templated replies on the threads that stay open, and a `## Code review — verification round` summary. The round reviews no new code. A delta review inside it would bypass the auto-pause counter, which comment events never read, so pushes are what get reviewed and `@claude review` is the remedy for a paused, cancelled, or draft head.

Verdicts carry three states. `fixed` resolves the thread; `still_applies` and `cannot_verify` post a reply citing the sha and the evidence and leave it open.

#### The verify job's two walls

The verify agent's verdicts drive `mutate`, which holds `contents: write`. So the round that produces them runs in its own job, `verify`, and two lines in that job are what keep a model away from write power. Both are invariants. Changing either is an invariant change, not a tuning edit:

1. **The job declares no `id-token: write`.** That permission is the sole input to the `claude[bot]` App-token mint: the action calls `core.getIDToken()` and exchanges the result at `api.anthropic.com/api/github/github-app-token-exchange` for a token carrying `contents: write, pull_requests: write, issues: write`. The installation is org-wide with `repos=all`; the minted token's exact repository scope has not been measured here, so this deliberately claims only the permissions, not the breadth. Without the permission the runner never injects the OIDC request environment and `getOidcToken` throws, so the mint path fails closed.
2. **`github_token: ${{ github.token }}` is passed to the action.** A provided token reaches `OVERRIDE_GITHUB_TOKEN` and `setupGitHubToken` returns it before any OIDC request is attempted.

The job's own `GITHUB_TOKEN` is capped at `contents: read`, `pull-requests: read`, `issues: read`, so the credential the agent does hold cannot post, resolve, push, or mint. Its `--allowed-tools` list (`Read,Grep,Glob,LS,Bash(gh pr diff:*)`) is a third line, not the wall: a carelessly widened allowlist would reach more reading, and nothing else.

A permanent tripwire step runs first in the job and fails it if `ACTIONS_ID_TOKEN_REQUEST_URL` is non-empty, so `id-token: write` leaking back in — through a workflow edit or a drifted `@v1` tag — dies loudly instead of silently reopening the mint path.

Verdicts reach `mutate` as the action's `structured_output`, validated against a JSON schema and then re-gated: the job fails unless the output parses, every entry matches the three-state enum and the sha and evidence shapes, and every staged thread has a verdict. A thread the agent silently dropped is a red job, not a thread that quietly stays open.

Story: `prismalens/gh-workflows#20`. Canary results are recorded on the pull request that shipped this.

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

## Action Pinning and Dependabot

To guard against supply chain tampering from repointed tags, every third-party GitHub Action used across workflows and composite actions is pinned to a full commit SHA:

- `actions/checkout`
- `actions/upload-artifact`
- `actions/download-artifact`
- `anthropics/claude-code-action`
- `amannn/action-semantic-pull-request`
- `dependabot/fetch-metadata`

First-party actions and workflows hosted in `prismalens/gh-workflows` (such as `actions/admit` and caller stubs) reference `@main` for live inheritance across ecosystem repositories.

### Dependabot configuration

Dependabot (`.github/dependabot.yml`) checks for updates to pinned GitHub Actions weekly across:
- `/` for root workflows (`.github/workflows/`)
- `/actions/pr-title` for composite action dependencies

Minor and patch updates are grouped into a single PR (`minor-and-patch`). Major updates are excluded from grouping and open as individual PRs for manual human review.

Consumer repositories can invoke `.github/workflows/dependabot-auto-merge.yml` to automatically merge grouped minor and patch action bumps once required status checks pass.

---

## Consumer Repositories

The following consumer repositories use shared CI from this repository (replacing `consumers.json`):

- `prismalens/prismalens`
- `prismalens/sreforge`
- `Sumit1993/mage-memory`

---

## Copy-Sync Retirement

The copy-sync mechanism (`canonical/`, `scripts/sync-consumer.sh`, `scripts/check-drift.sh`, `consumers.json`) is retired. Reusable workflows (`workflow_call`) and composite actions make workflow drift structurally impossible for shared CI lanes across consumer repositories.
