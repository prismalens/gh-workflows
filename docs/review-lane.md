# Review lane

## Worked-Example Consumer Stub (Review Lane)

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

## Review lane inputs

All optional `workflow_call` inputs on `claude-code-review.yml`; the defaults are the intended posture and a stub only sets them to deviate.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `skip_authors` | string | `dependabot[bot]` | Comma-separated PR author logins whose **automatic** `pull_request` rounds are skipped entirely — no review, no verify, no liveness comment. Matching is exact-login (the list is delimiter-wrapped), so `bot` never collides with `dependabot[bot]`. Use no spaces after the commas. A `@claude review` summon bypasses the list: manual intent wins. |
| `auto_pause_rounds` | number | `5` | Automatic rounds allowed on one PR before the lane pauses itself. The count lives in the liveness comment's marker (`<!-- claude-review-liveness rounds=N sha=<head> -->`); only automatic rounds that actually ran increment it. On pause the lane posts `auto-paused after N automatic rounds` instead of reviewing. A `@claude review` summon that **posts review output** resumes the lane and resets the counter to 0; a summon that finished green having posted nothing is not a resume and leaves the count untouched. |
| `default_model` | string | `claude-sonnet-5` | Model ID handed to `claude-code-action` as `--model`, for all three review shapes (review, full review, verify). Sonnet is the default deliberately: the review lane is the highest-volume Claude spend across the consumer repos. A single run can deviate with `--model <alias>` in a summon, choosing from the `model_aliases` allowlist. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription, not by this input. |
| `model_aliases` | string | `opus=claude-opus-5,sonnet=claude-sonnet-5` | Comma-separated `alias=model-id` pairs selectable with `--model <alias>` in a summon. The alias is matched against the comment; the ID is emitted from this list and is never read out of the comment. An alias absent here is not selectable. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription, not by this input. |
| `display_report` | boolean | `false` | Render the review round's reasoning and token/cost usage into the Actions Step Summary (opt-in; set `display_report: true` in the stub to turn on). The summary is world-readable on a public repository; the content is Claude-authored text derived from the pull request diff, which is already public there. When the execution file is missing, empty, or unparseable, the step warns and does not fail the job. |

## Setting inputs per repository

Repository-level settings can be configured using a per-repo configuration file (`.github/claude-review.yml`) or via the `with:` input block in the caller stub.

### Configuration file (`.github/claude-review.yml`)

Repositories can define review settings in `.github/claude-review.yml`.

#### Security invariant: read from the base ref, never the head (#33)

The configuration file is read strictly from the pull request's **base ref** (`.base.sha`) via GitHub's Contents REST API (`gh api repos/$REPO/contents/.github/claude-review.yml?ref=$BASE_SHA`), and never from the checked-out working tree or PR head commit.

Because the PR head and merge ref are under the author's control, reading configuration from the head would allow an attacker to modify review policies for their own PR (e.g. increase `auto_pause_rounds`, downgrade `default_model`, alter `path_filters`, or add themselves to `skip_authors`) in the very commit under review.

#### Configuration schema and wired keys

The configuration schema is strictly validated against the S0 specification.

| Key | Type | Status | Meaning |
| --- | --- | --- | --- |
| `version` | integer | **Consumed** | Schema version (must be integer `1`). |
| `review.default_model` | string | **Consumed** | Default model ID for review runs (`claude-sonnet-5` or `claude-opus-5`). |
| `review.auto_pause_rounds` | integer | **Consumed** | Automatic review rounds limit before pausing (integer >= 1). |
| `review.skip_authors` | list of strings | **Consumed** | Author logins whose automatic `pull_request` rounds are skipped entirely. |
| `review.path_filters` | list of strings | **Consumed** | Glob patterns for high-risk files that escalate the review model to Opus. |
| `review.path_instructions` | list of mappings | *Schema-accepted, not yet wired* | Path-specific instructions for review agents. Emits warning if present. |
| `findings.suppress_below` | string | *Schema-accepted, not yet wired* | Minimum severity threshold (`none`, `Minor`, `Major`, `Critical`). Emits warning if present. |
| `findings.enable_ai_fix_prompt` | boolean | *Schema-accepted, not yet wired* | Whether to include AI fix prompt details. Emits warning if present. |
| `findings.include_verification_note` | boolean | *Schema-accepted, not yet wired* | Whether to include verification notes. Emits warning if present. |

#### Three parse outcomes

1. **Absent (HTTP 404)**: When `.github/claude-review.yml` does not exist at the base ref, workflow defaults apply and a single informative line is logged (`No .github/claude-review.yml found at base ref <sha>; applying workflow defaults.`). No warning is emitted.
2. **Malformed**: If the file contains invalid YAML, unknown keys, invalid schema versions, or disallowed values, the lane emits a `::warning::` annotation naming the file, the base SHA, and the validator's error output, and falls back to workflow defaults. A broken configuration is never silently treated as intentional defaults.
3. **Valid**: The lane consumes supported keys (`default_model`, `auto_pause_rounds`, `skip_authors`, `path_filters`), logs the consumed values, and overrides the corresponding workflow inputs. If any schema-valid but unwired keys are present (e.g. `review.path_instructions` or `findings.*`), one `::warning::` annotation is emitted listing those keys.

#### Precedence

- A valid setting in `.github/claude-review.yml` overrides the corresponding `workflow_call` input in the caller stub's `with:` block.
- Any setting absent or omitted from `.github/claude-review.yml` falls back to the caller stub's `with:` input (or the workflow's built-in default).
- Security-critical controls remain workflow-only inputs and are never configurable in `.github/claude-review.yml`: `--allowed-tools`, `id-token` write permissions, and fork handling.

### Model escalation from changed files (#34)

Before the review agent runs, the lane inspects the list of changed files in the pull request and selects the model up front:

- **Default**: `review.default_model` (Sonnet by default: `claude-sonnet-5`).
- **High-Risk Escalation**: If the repository config defines `review.path_filters` and any file modified in the pull request matches one of the glob patterns, the review model is escalated to Opus (`claude-opus-5`).
  - Glob matching uses Python's `fnmatch`, with trailing `/**` matching a directory and all of its descendants recursively.
- **Summon Override Precedence**: An explicit model alias in a summon (e.g. `@claude review --model sonnet` or `@claude review --model opus`) always takes precedence over path-based escalation. Manual intent wins.
- **Evidence Naming**: The advisory liveness comment explicitly names the model used and the resolution reason (`default`, `summon override`, or `escalated by path match`).

```yaml
  review:
    uses: prismalens/gh-workflows/.github/workflows/claude-code-review.yml@main
    with:
      display_report: true
      auto_pause_rounds: 3
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

## Summon grammar

Bare PR comments, admitted accounts only: the summoning account must hold `admin` or `write` on the repository, checked live by the `admit` action. The comment body is read only by workflow `contains()` expressions and alias matching — it never reaches a prompt.

| Comment | Lane | Behaviour |
| --- | --- | --- |
| `@claude review` | review | Incremental. A verify round still wins when unresolved `claude[bot]` threads exist. Otherwise the round is scoped to the commits since the last round that posted review output, read from the `sha=` field of the liveness marker. On a head that has already been reviewed with no open threads, the summon gives a full review rather than doing nothing. |
| `@claude full review` | review | From scratch. Forces a review and instructs it to ignore existing comments and threads as dedup targets — without that the plugin's dedup silently publishes nothing (prismalens/prismalens#410). |
| `@claude review --model <alias>` / `@claude full review --model <alias>` | review | Runs that review shape on the model ID mapped to `<alias>` in `model_aliases` (default `opus=claude-opus-5,sonnet=claude-sonnet-5`). An unrecognized alias falls back to `default_model` and emits a warning annotation. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription. |
| bare `@claude …` | mention | Anything not matching the verbs above. |

Summons run on draft PRs (explicit intent overrides the draft skip) and reset the auto-pause counter to 0, but only when the round actually posted review output — the same evidence that advances `sha=`. Fork-head PRs stay refused even when summoned (v1) — they get the `<!-- claude-review-fork-notice -->` comment instead.

## Incremental review

The baseline is the `sha=` in `<!-- claude-review-liveness rounds=N sha=<head> -->`, and it advances only on a round that posted review output. A verify round never advances it.

The range is computed with `gh api repos/OWNER/REPO/compare/BASE...HEAD`, not git: the checkout is `fetch-depth: 1` and on `pull_request` it is the merge ref, so a local diff would be both impossible and wrong. The compare payload is staged in `.claude-incremental-range.json` for the review agent.

Six conditions fall back to a full review, each logged by name: `no-baseline`, `identical-summon`, `baseline-gone` (the compare 404 after a force-push), `diverged` (which also covers `behind`), `range-too-large` (>= 300 files), and `unexpected-status-<status>`.

An automatic round on a head with no new commits skips, and the liveness comment says so rather than reporting a review.

An incremental round's summary comment is headed `## Code review — incremental (<base>..<head>)` with 7-character short SHAs, and it still begins with the literal `## Code review` because the liveness evidence filter matches on that prefix.

## Step Summary review report

When `display_report` is `true` (opt-in; defaults to `false`), the review lane renders a structured report of the review round directly into the Actions Step Summary:

- **Context Table**: Pull request number, repository, head SHA (short), review round type (`review`, `review-full`, `incremental`), model ID, GitHub run ID, and session ID.
- **Usage Table**: Aggregates token usage (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), total cost in USD (`total_cost_usd`), run duration (`duration_ms`), turn count (`num_turns`), and permission denials (`permission_denials`).
- **Reasoning**: Renders the assistant's text reasoning turns directly as Markdown.

The output is capped at 1,000,000 bytes to stay within GitHub's 1 MiB Step Summary limit. When the execution file is missing, empty, or fails to parse as JSON, the step emits a warning annotation and exits cleanly (exit 0) without failing the review job.

## Advisory liveness comment

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

## Verification rounds (incremental re-review)

Replies from a non-bot account to unresolved `claude[bot]` threads trigger a verify round: one verdict per open thread, then automated resolution via `resolveReviewThread`, templated replies on the threads that stay open, and a `## Code review — verification round` summary. The round reviews no new code. A delta review inside it would bypass the auto-pause counter, which comment events never read, so pushes are what get reviewed and `@claude review` is the remedy for a paused, cancelled, or draft head.

Verdicts carry three states. `fixed` resolves the thread; `still_applies` and `cannot_verify` post a reply citing the sha and the evidence and leave it open.

### The verify job's two walls

The verify agent's verdicts drive `mutate`, which holds `contents: write`. So the round that produces them runs in its own job, `verify`, and two lines in that job are what keep a model away from write power. Both are invariants. Changing either is an invariant change, not a tuning edit:

1. **The job declares no `id-token: write`.** That permission is the sole input to the `claude[bot]` App-token mint: the action calls `core.getIDToken()` and exchanges the result at `api.anthropic.com/api/github/github-app-token-exchange` for a token carrying `contents: write, pull_requests: write, issues: write`. The installation is org-wide with `repos=all`; the minted token's exact repository scope has not been measured here, so this deliberately claims only the permissions, not the breadth. Without the permission the runner never injects the OIDC request environment and `getOidcToken` throws, so the mint path fails closed.
2. **`github_token: ${{ github.token }}` is passed to the action.** A provided token reaches `OVERRIDE_GITHUB_TOKEN` and `setupGitHubToken` returns it before any OIDC request is attempted.

The job's own `GITHUB_TOKEN` is capped at `contents: read`, `pull-requests: read`, `issues: read`, so the credential the agent does hold cannot post, resolve, push, or mint. Its `--allowed-tools` list (`Read,Grep,Glob,LS,Bash(gh pr diff:*)`) is a third line, not the wall: a carelessly widened allowlist would reach more reading, and nothing else.

A permanent tripwire step runs first in the job and fails it if `ACTIONS_ID_TOKEN_REQUEST_URL` is non-empty, so `id-token: write` leaking back in — through a workflow edit or a drifted `@v1` tag — dies loudly instead of silently reopening the mint path.

Verdicts reach `mutate` as the action's `structured_output`, validated against a JSON schema and then re-gated: the job fails unless the output parses, every entry matches the three-state enum and the sha and evidence shapes, and every staged thread has a verdict. A thread the agent silently dropped is a red job, not a thread that quietly stays open.

Story: `prismalens/gh-workflows#20`. Canary results are recorded on the pull request that shipped this.

## Fork PRs

Fork heads never reach the reviewer: GitHub withholds the repository's secrets from fork code, and this lane deliberately does not use `pull_request_target`. A separate `fork-notice` job upserts a `<!-- claude-review-fork-notice -->` comment saying so and pointing at the `coderabbit_review` label. Fork `pull_request` runs also hold a read-only `GITHUB_TOKEN` unless the repository enables *Send write tokens to workflows from fork pull requests* (off by default); when the comment is denied, the job falls back to a workflow warning annotation carrying the same text.
