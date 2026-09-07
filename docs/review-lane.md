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
  # The lane's own emissions must never enter a real group. Concurrency is allocated at run
  # creation, before any job `if:` runs, so the callee's admission gate cannot keep them out:
  # a `claude[bot]` verdict comment took the pending seat and cancelled the queued human
  # reply four times out of four. Story: prismalens/gh-workflows#12.
  group: >-
    ${{ (github.event.comment.user.type == 'Bot'
         || (github.event_name == 'issue_comment' && !github.event.issue.pull_request))
        && format('claude-code-review-junk-{0}', github.run_id)
        || format('claude-code-review-{0}', github.event.pull_request.number || github.event.issue.number) }}
  # A summon never cancels an in-flight automatic round; it queues behind it.
  # A push still supersedes anything in the group, including a summon.
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  review:
    # Caller-side draft guard: skip before the reusable workflow is even invoked
    # (the callee carries a backstop guard; GitHub cannot filter drafts at the trigger).
    if: github.event.pull_request.draft != true
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
`issue_comment`. Everything the lane itself emits goes to a per-run junk group
instead, which is what keeps its own verdict comment out of the seat a human
reply is waiting for. See [Run scheduling](#run-scheduling) for what the group
does once more than one event arrives at once.

This example is the stub the consumers actually run, byte for byte in its
concurrency and guard. Copy it as-is: a stub that predates a fix here
reproduces the bug that fix closed.

## Review lane inputs

All optional `workflow_call` inputs on `claude-code-review.yml`; the defaults are the intended posture and a stub only sets them to deviate.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `skip_authors` | string | `dependabot[bot]` | Comma-separated PR author logins whose **automatic** `pull_request` rounds are skipped entirely — no review, no verify, no liveness comment. Matching is exact-login (the list is delimiter-wrapped), so `bot` never collides with `dependabot[bot]`. Use no spaces after the commas. A `@claude review` summon bypasses the list: manual intent wins. |
| `auto_pause_rounds` | number | `5` | Automatic rounds allowed on one PR before the lane pauses itself. The count lives in the liveness comment's marker (`<!-- claude-review-liveness rounds=N sha=<head>( paused=1)? -->`); only automatic rounds that actually ran increment it. On pause the lane posts `auto-paused after N automatic rounds` instead of reviewing. A PR can also be paused explicitly via `@claude pause` (setting `paused=1`). A `@claude resume` summon clears the pause state, while a `@claude review` summon that **posts review output** resumes the lane and resets the counter to 0; a summon that finished green having posted nothing is not a resume and leaves the count untouched. |
| `default_model` | string | `claude-sonnet-5` | Model ID handed to `claude-code-action` as `--model`, for all three review shapes (review, full review, verify). Sonnet is the default deliberately: the review lane is the highest-volume Claude spend across the consumer repos. A single run can deviate with `--model <alias>` in a summon, choosing from the `model_aliases` allowlist. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription, not by this input. |
| `model_aliases` | string | `opus=claude-opus-5,sonnet=claude-sonnet-5` | Comma-separated `alias=model-id` pairs selectable with `--model <alias>` in a summon. The alias is matched against the comment; the ID is emitted from this list and is never read out of the comment. An alias absent here is not selectable. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription, not by this input. |
| `display_report` | boolean | `false` | Render the review round's reasoning and token/cost usage into the Actions Step Summary (opt-in; set `display_report: true` in the stub to turn on). The summary is world-readable on a public repository; the content is Claude-authored text derived from the pull request diff, which is already public there. When the execution file is missing, empty, or unparseable, the step warns and does not fail the job. |

## Review configuration and four-layer precedence (#33, #54)

Review lane settings are resolved dynamically through a **four-layer precedence hierarchy** (evaluated from lowest to highest):

1. **Workflow Input Defaults**: Built-in defaults declared in the `claude-code-review.yml` callee workflow (`default_model: claude-sonnet-5`, `auto_pause_rounds: 5`, `skip_authors: dependabot[bot]`, `path_filters: []`).
2. **Organization-Level Defaults**: Shared ecosystem defaults defined in [`.github/claude-review-defaults.yml`](../.github/claude-review-defaults.yml) hosted in this repository (`prismalens/gh-workflows`).
3. **Repository Configuration**: Per-repository review configuration defined in `.github/claude-review.yml` in the consumer repository, read from its base ref.
4. **Summon Override**: An explicit `--model <alias>` parameter in a `@claude review` or `@claude full review` PR comment (highest precedence).

### Key-by-key pure override

Configuration merges **per key**, not per file:
- **Pure override**: The repository layer wins outright over organization defaults on any key it defines. Repositories may loosen shared constraints, not only tighten them (e.g. if org defaults specify `auto_pause_rounds: 3`, a repository may set `auto_pause_rounds: 10`).
- **Inheritance**: Any key omitted by a repository falls back to the organization defaults (or workflow defaults). A repository configuring only `default_model` inherits `auto_pause_rounds`, `skip_authors`, and `path_filters` from the org defaults.
- **Concatenation exception (`review.path_instructions`)**: `review.path_instructions` is a deliberate one-key exception to the pure override rule. Because instructions are additive guidance rather than a setting with a single value, organization and repository lists concatenate, organization entries first. An organization entry states an ecosystem invariant that a consumer should not silently drop by defining its own entries. A repository that disagrees or provides additional guidance writes its own, which lands later in the file. No deduplication or per-path override is performed.

### Shared organization defaults (`.github/claude-review-defaults.yml`)

Because `Sumit1993/mage-memory` is user-owned while other consumer repositories are organization-owned, organization rulesets and a `prismalens/.github` repository cannot reach all consumers. Hosting shared defaults in `gh-workflows` allows all callers to access ecosystem policy via a standard REST API read with no new credentials.

#### Organization defaults ref (`@main`) (#54)

Organization defaults are fetched from `prismalens/gh-workflows` at `main`:

```text
gh api repos/prismalens/gh-workflows/contents/.github/claude-review-defaults.yml?ref=main
```

- **Compatibility**: No `github.*` context exposes the callee's own ref from inside a called workflow, so a version-matched read is not available. Compatibility is guarded by the schema's required `version` key (pinned to integer `1`). An unexpected version or malformed YAML rejects the organization layer with a warning and drops it from the merge. The consumer's `.github/claude-review.yml` still loads from its base ref, so the effective configuration is the repository layer over workflow defaults.
- **Pinned consumer retrofit**: If a consumer ever pins a SHA, add a `workflows_ref` input to that caller stub and thread it to the organization defaults fetch.

### Repository configuration (`.github/claude-review.yml`)

#### Security invariant: read from the base ref, never the head (#33)

The per-repo configuration file is read strictly from the pull request's **base ref** (`.base.sha`) via GitHub's Contents REST API:

```text
gh api repos/$REPO/contents/.github/claude-review.yml?ref=$BASE_SHA
```

Because the PR head and merge ref are under the author's control, reading configuration from the head would allow an attacker to modify review policies for their own PR (e.g. increase `auto_pause_rounds`, downgrade `default_model`, alter `path_filters`, or add themselves to `skip_authors`) in the very commit under review.

### Configuration schema and wired keys

Both `.github/claude-review-defaults.yml` and `.github/claude-review.yml` share the exact same schema, strictly validated by the same inline validator:

| Key | Type | Status | Meaning |
| --- | --- | --- | --- |
| `version` | integer | **Consumed** | Schema version (must be integer `1`). |
| `review.default_model` | string | **Consumed** | Default model ID for review runs (`claude-sonnet-5` or `claude-opus-5`). |
| `review.auto_pause_rounds` | integer | **Consumed** | Automatic review rounds limit before pausing (integer >= 1). |
| `review.skip_authors` | list of strings | **Consumed** | Author logins whose automatic `pull_request` rounds are skipped entirely (no review, no verify, and no liveness comment is posted). |
| `review.path_filters` | list of strings | **Consumed** | Glob patterns for files excluded from review size metrics and agent diffs. Defaults to generated files and lockfiles (#105). Pure override if set. |
| `review.escalation_paths` | list of strings | **Consumed** | Glob patterns for high-risk files that escalate the review model to Opus (`claude-opus-5`). Pure override if set. |
| `review.path_instructions` | list of mappings | **Consumed** | Path-specific instructions for review agents; concatenates organization and repository entries (org first). Matched against changed files and staged in `.claude-path-instructions.md`. |
| `findings.suppress_below` | string | *Schema-accepted, not yet wired* | Minimum severity threshold (`none`, `Minor`, `Major`, `Critical`). Emits warning if present. |
| `findings.enable_ai_fix_prompt` | boolean | *Schema-accepted, not yet wired* | Whether to include AI fix prompt details. Emits warning if present. |
| `findings.include_verification_note` | boolean | *Schema-accepted, not yet wired* | Whether to include verification notes. Emits warning if present. |

### Three parse outcomes (Org and Repo layers)

1. **Absent (HTTP 404)**: When a config file does not exist, prior defaults apply cleanly and a single info line is logged (`No .github/claude-review-defaults.yml found at ref <ref>; applying workflow defaults.` or `No .github/claude-review.yml found at base ref <sha>; applying workflow defaults.`). No warning is emitted.
2. **Malformed**: If a file contains invalid YAML, unknown keys, invalid schema versions, or disallowed values, the lane emits a `::warning::` annotation naming the file, the ref / base SHA, and the validator's error output, and ignores that layer entirely. A broken config file never takes down the review lane.
3. **Valid**: Supported keys (`default_model`, `auto_pause_rounds`, `skip_authors`, `path_filters`, `escalation_paths`, `path_instructions`) are consumed, logged, and merged into the effective configuration. Any schema-valid but unwired keys emit a `::warning::` annotation listing those keys.

### Per-key source logging

When configuration loading completes, the run logs the effective configuration and explicitly attributes each key to its source layer (`workflow default`, `org defaults`, `repo config`, or `summon override`):

```text
Effective review configuration:
  review.default_model: claude-sonnet-5 (source: repo config)
  review.auto_pause_rounds: 8 (source: org defaults)
  review.skip_authors: dependabot[bot] (source: workflow default)
  review.path_filters: ['packages/**'] (source: org defaults)
```

Security-critical controls remain workflow-only inputs and are never configurable in `.github/claude-review.yml` or `.github/claude-review-defaults.yml`: `--allowed-tools`, `id-token` write permissions, and fork handling.

### Generated file filters and review size metrics (`review.path_filters`) (#105)

Lockfiles and generated files (such as `package-lock.json`, vendored trees, and minified assets) distort review metrics and exhaust the review agent's turn budget while producing zero inline findings. To prevent mechanical files from polluting review size or triggering line caps, the review lane applies default path filters to exclude them from `changed_files` and `diff_lines` calculations before agent prompts and telemetry records are constructed.

#### Built-in default path filters

When `review.path_filters` is omitted, the workflow applies the following default patterns:
- `package-lock.json`
- `pnpm-lock.yaml`
- `yarn.lock`
- `Cargo.lock`
- `poetry.lock`
- `go.sum`
- `dist/**`
- `build/**`
- `vendor/**`
- `**/__snapshots__/**`
- `*.min.js`
- `*.min.css`
- `**/node_modules/**`

#### Override semantics

`review.path_filters` follows strict **pure override** semantics:
- Defining `review.path_filters` in a repository's `.github/claude-review.yml` (or in organization defaults) **replaces** the built-in defaults entirely rather than merging with them. Unlike `path_instructions`, `path_filters` does not concatenate.
- To disable all filtering, set `review.path_filters: []`.

#### Telemetry and logging

- The filter step logs pattern and exclusion counts on every run:
  ```text
  path_filters: N patterns, K of M changed file(s) excluded
  ```
- Telemetry records both metrics: post-exclusion values (`changed_files`, `diff_lines`) and raw pre-exclusion values (`changed_files_raw`, `diff_lines_raw`), preserving visibility into diff sizes before filtering.

### Model escalation from changed files (#34)

Before the review agent runs, the lane inspects the list of changed files in the pull request and selects the model up front:

- **Default**: `review.default_model` (Sonnet by default: `claude-sonnet-5`).
- **High-Risk Escalation**: If the repository config or organization defaults define `review.escalation_paths` and any file modified in the pull request matches one of the glob patterns, the review model is escalated to Opus (`claude-opus-5`). `review.escalation_paths` controls model escalation (#34), whereas `review.path_filters` controls file exclusion from review size metrics and agent diffs (#105).
  - Glob matching uses Python's `fnmatch`, with trailing `/**` matching a directory and all of its descendants recursively.
- **Summon Override Precedence**: An explicit model alias in a summon (e.g. `@claude review --model sonnet` or `@claude review --model opus`) always takes precedence over path-based escalation. Manual intent wins.
- **Evidence Naming**: The advisory liveness comment explicitly names the model used and the resolution reason (`default`, `summon override`, `escalated by path match`, or `default (changed-files fetch failed)`).

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
| `@claude review` | review | Incremental. A verify round still wins when unresolved `claude[bot]` threads exist. Otherwise the round is scoped to the commits since the last round that posted review output, read from the `sha=` field of the liveness marker. On a head that has already been reviewed with no open threads, the summon gives a full review rather than doing nothing. Clears `paused=1` if paused. |
| `@claude full review` | review | From scratch. Forces a review and instructs it to ignore existing comments and threads as dedup targets — without that the plugin's dedup silently publishes nothing (prismalens/prismalens#410). Clears `paused=1` if paused. |
| `@claude review --model <alias>` / `@claude full review --model <alias>` | review | Runs that review shape on the model ID mapped to `<alias>` in `model_aliases` (default `opus=claude-opus-5,sonnet=claude-sonnet-5`). An unrecognized alias falls back to `default_model` and emits a warning annotation. Which IDs actually resolve is decided by the `CLAUDE_CODE_OAUTH_TOKEN` subscription. |
| `@claude pause` | pause | Pauses the review lane on this pull request without running a review. Updates the liveness marker with `paused=1`. Automatic review rounds on subsequent pushes are skipped while paused (#124). |
| `@claude resume` | resume | Resumes a paused review lane on this pull request without immediately triggering a review. Clears `paused=1` from the liveness marker and resets the round counter so subsequent pushes trigger automatic rounds (#124). |
| bare `@claude …` | mention | Anything not matching the verbs above. |

Summons do not run on draft PRs: nothing reviews a draft, and the lane takes the whole diff in one round once the pull request is marked ready. A summon on a draft still reaches the callee, because `issue_comment` carries no `pull_request` object for the caller stub's guard to test, so it gets a `draft` verdict on the liveness comment rather than silence. Summons reset the auto-pause counter to 0, but only when the round actually posted review output — the same evidence that advances `sha=`. `@claude pause` explicitly pauses the lane (setting `paused=1`), while `@claude resume` clears the pause state. Fork-head PRs stay refused even when summoned (v1) — they get the `<!-- claude-review-fork-notice -->` comment instead.

## Run scheduling

How a run is allocated, and when one is cancelled by another. Every claim here is a
condition in the caller stub above or in `claude-code-review.yml`, named so it can be
re-checked; the incidents behind them are in #12, #63 and #149.

**One seat, one waiting room.** All three events resolve to the group
`claude-code-review-<pr>`. GitHub's own contract for that, under
[`concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency):

> This means that there can be at most one running job or workflow in a concurrency group at
> any time. When a concurrent job or workflow is queued, if another job or workflow using the
> same concurrency group in the repository is in progress, the queued job or workflow will be
> `pending`. By default, any existing `pending` job or workflow in the same concurrency group
> will be canceled and the new queued job or workflow will take its place.

**So N replies fire N runs, and the middle ones die.** Each in-thread reply is a
`pull_request_review_comment` run entering that one group. One holds the seat, one waits, and
every later arrival evicts the one waiting. Those evicted runs conclude `cancelled` with zero
jobs, which reads exactly like breakage and is not: one verify round re-checks *every*
unresolved thread, so the survivor covers the threads the evicted runs would have. The cost is
latency and invisibility, never coverage.

**A push supersedes anything queued, summons included.** `cancel-in-progress` is
`${{ github.event_name == 'pull_request' }}`, true only for pushes. A comment event therefore
never cancels a running round, and a push cancels whatever is in the group. The common fix
cycle walks straight into this: fix, push, reply in thread, and the push kills the verify round
the reply asked for. The reliable order is **fix, push, reply, then exactly one
`@claude review` after the last push**. A round lost that way is reported as
`verify-superseded`, but only when `announce` can see that the head has actually moved. A
cancelled `mutate` on an unmoved head is `verify-cancelled`, which names no cause, because a
cancellation is not by itself evidence of what cancelled it.

**The seat is held for up to thirty minutes.** `review` carries `timeout-minutes: 30` against a
measured baseline of 5.03 minutes mean and 12.72 peak (#63). Past that a run is hung, and
because `cancel-in-progress` is false for comment events nothing evicts it, so it holds the
group's seat for the remainder while each arriving reply evicts the one pending behind it.

**The lane's own comments never enter the group.** `github.event.comment.user.type == 'Bot'`,
and an `issue_comment` on something that is not a pull request, both divert to
`claude-code-review-junk-<run_id>`. Concurrency is allocated at run creation, before any job
`if:` runs, so the callee's admission gate cannot keep them out and the group key has to
(#12). A `cancelled` review-comment run with zero jobs is the pending-slot rule above, never
evidence that a stub predates this fix.

**Drafts.** Nothing reviews a draft, by any trigger. Automatic rounds and in-thread replies are
stopped by the caller stub's guard, so no run is spent and nothing is posted. A summon reaches
the callee, because `issue_comment` carries no `pull_request` object for that guard to test,
and gets a `draft` verdict on the liveness comment rather than silence, plus a `draft` lane
event, because a run that reviewed nothing is a round that never happened.

## Incremental review

The baseline is the `sha=` in `<!-- claude-review-liveness rounds=N sha=<head>( paused=1)? -->`, and it advances only on a round that posted review output. A verify round never advances it.

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

The `announce` job upserts an advisory comment on the pull request timeline matching `<!-- claude-review-liveness rounds=N sha=<head>( paused=1)? -->` to report review status and prevent silent review failures.

- **Round counter (`rounds=N`)**: Increments only on automatic `pull_request` runs that actually executed and succeeded. Paused, cancelled, failed, or token-less runs do not increment it. An explicit `@claude review` summon that posts review output resets `rounds` to 0.
- **Head baseline (`sha=<head>`)**: Advances to the current PR head only when the review round produces posted review output.
- **Pause state (`paused=1`)**: Present when the lane has been paused either explicitly via `@claude pause` or automatically after reaching `auto_pause_rounds`. When paused, automatic review rounds on new commits are skipped. `@claude resume` clears `paused=1` and resets `rounds` to 0; `@claude review` also clears `paused=1` and resets `rounds` to 0 if it posts review output (#124).
- **Inline comment counting**: The liveness marker counts inline review comments left by `claude[bot]`. The count strictly matches `original_commit_id == HEAD_SHA` (the commit against which the comment was originally created). It avoids `commit_id`, which GitHub automatically rewrites forward as new commits are pushed to the PR. Carried-forward comments from prior heads are therefore never counted as work performed during the current round, preventing stale comments from advancing the baseline or resetting the auto-pause limit.
- **Suppressed for skipped authors**: When a pull request's author matches `skip_authors`, the lane skips the round entirely and posts no liveness comment to the pull request timeline (preventing comment noise on automated PRs).
- **Summary comments**: Filters `claude[bot]` issue comments created since run start with the `## Code review` heading prefix.

### The verdicts

`announce` emits one of the following verdict strings. Only the first two mean the head was read.

| Verdict | Head reviewed? |
| --- | --- |
| `reviewed <sha> and posted N inline / M summary comment(s)` | **Yes** |
| `reviewed <sha> (incremental from <base>) and posted N inline / M summary comment(s)` | **Yes** |
| `finished on <sha> (job result: X) but posted **nothing**` | No |
| `re-checked open threads at <sha>: N resolved / M left open` | **No** — threads only, no code was read |
| `ran a verification round on <sha> (mutate result: X) but posted **nothing**` | No |
| `the verification round on <sha> was cancelled when the head moved to <sha>` | No — `cancel-in-progress` doing its job; summon once after the last push |
| `the verification round on <sha> was cancelled before it posted a summary, and the head has not moved` | No — cause not recorded; read the run log |
| `auto-paused after N automatic rounds at <sha> — re-request with \`@claude review\`.` | No |
| `paused by request at <sha>; resume with \`@claude resume\`.` | No |
| `not reviewed at <sha>: the pull request is a draft` | No |
| `did not run at <sha>: the diff is below this repo's \`min_diff_lines\` floor` | No |
| `did not run at <sha>: the head moved during the debounce window` | No |
| `did not run at <sha>: no CLAUDE_CODE_OAUTH_TOKEN reached this lane` | No |
| `no new commits since <sha> was last reviewed; nothing to re-review` | No |

Each verdict carries a `verdict_kind` onto the telemetry row, and the dashboard buckets rounds
by it. A kind the dashboard does not know is displayed as an error, so the two lists are held
together by `tests/test-verdict-kind-drift.py` rather than by attention.

The **Head reviewed?** column is the pre-merge test, and it exists because inference fails on
the verification verdict: `8 resolved / 0 left open` reads like success while saying nothing
about whether the code was read. Answer the question by looking it up in this table, never by
reading the prose.

A verification round is not review evidence for the head it ran against. It re-checks open
threads and reads no new code, which is also why it never advances `sha=`.

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

Replies from a non-bot account to unresolved `claude[bot]` threads trigger a verify round: one verdict per open thread, then automated resolution via `resolveReviewThread`, templated replies on the threads that stay open, and a `## Code review — verification round` summary. The round reviews no new code. A delta review inside it would bypass the auto-pause counter, which comment events never read, so pushes are what get reviewed and `@claude review` is the remedy for a paused or cancelled head. A draft head has no remedy but marking it ready.

Verdicts carry three states. `fixed` resolves the thread; `still_applies` and `cannot_verify` post a reply citing the sha and the evidence and leave it open.

Each verdict also copies the thread's `path` as an anchor. `mutate` compares it against the live
thread and discards the entry on a mismatch, counting it in the summary's discarded total. The
agent binds its evidence to a `thread_id` itself and no later job can re-derive that pairing, so
without the anchor a misaligned entry posts a confident reply about a different thread's finding,
which is what happened three times on `Sumit1993/mage-memory#206` (#148). The anchor is a field
the agent copies, never one it derives, because only a copy is checkable. Two open threads on one
file remain indistinguishable to it; that residual is stated rather than closed.

When a thread carries a reply from anyone but the lane, that reply is what the round is judging. A
`still_applies` has to say which claim in the reply it rejects and why the finding survives it.
Restating the original finding is not an answer to a counter-argument, and evidence that never
engages the reply is a `cannot_verify`.

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

## Pull request state tracking (`prs` table and `/pr-state`) (#136)

`usage_records` carries `pr_state`, `pr_title`, `pr_author`, `pr_base_ref`, and `pr_head_ref`. All five are captured during a review round and never revisited. They stay on `usage_records` as the historical snapshot of what each round saw.

**`usage_records.pr_*` is what the round saw and `prs.*` is what is true now.** A reader wanting current state must use `prs.*`.

### The `prs` table

The `prs` table in Cloudflare D1 (migration `0007_prs.sql`) stores current pull request facts decoupled from round snapshots:

| Column | Type | Description |
| --- | --- | --- |
| `repository` | TEXT NOT NULL | Repository (`owner/repo`), part of primary key |
| `pr_number` | INTEGER NOT NULL | Pull request number, part of primary key |
| `state` | TEXT | Current normalised state: `open`, `closed`, or `merged` |
| `title` | TEXT | Current PR title |
| `author` | TEXT | PR author login |
| `base_ref` | TEXT | Target branch name |
| `head_ref` | TEXT | Head branch name |
| `head_sha` | TEXT | Latest head commit SHA |
| `merged_at` | TEXT | Timestamp when merged (ISO 8601), or NULL |
| `closed_at` | TEXT | Timestamp when closed (ISO 8601), or NULL |
| `updated_at` | TEXT NOT NULL | Timestamp when the system last learned something (set server-side) |
| `source` | TEXT NOT NULL | How the fact was learned: `round`, `hook`, or `reconciler` |

`PRIMARY KEY (repository, pr_number)`
`INDEX idx_prs_state ON prs (state)`

Both `updated_at` and `source` are required on every row. A row that cannot state when or how it was learned is structurally incomplete.

### Source values

- `hook`: Event-driven push from consumer repositories via the `.github/workflows/pr-state.yml` caller stub on PR lifecycle events.
- `round`: Telemetry captured during review rounds.
- `reconciler`: Periodic reconciliation sweep walking the GitHub Actions / PRs API across repositories (#134).

### `POST /pr-state`

Authenticated via `Authorization: Bearer <REVIEW_TELEMETRY_TOKEN>` (identical to `/ingest`).

Request body:
- `repository` (string, required)
- `pr_number` (integer, required)
- `source` (string, required: must be `round`, `hook`, or `reconciler`)
- `state` (string, optional: must be `open`, `closed`, or `merged`)
- Optional strings: `title`, `author`, `base_ref`, `head_ref`, `head_sha`, `merged_at`, `closed_at`

Invariants:
- **Upsert on `(repository, pr_number)`**: An absent field leaves the stored value untouched rather than nulling it. Only what the caller actually knows gets written.
- **Normalised state validation**: `state` must be one of `open`, `closed`, `merged`. (GitHub PR API reports closed PRs with `merged: true`; callers normalise to `merged` before sending).
- **Server-side timestamp**: `updated_at` is generated server-side. Caller clocks are never trusted.
- **Race protection**: A later write with an older `updated_at` cannot overwrite a newer stored row (`WHERE excluded.updated_at >= prs.updated_at` and pre-write check).

### `GET /api/prs`

Returns paginated current PR records from `prs`, protected by Cloudflare Access JWT validation.

Query parameters:
- `repository` (optional): Filter by exact repository string.
- `state` (optional): Filter by state (`open`, `closed`, `merged`).
- `limit` (optional): Page size `1`..`1000` (default `100`).
- `cursor` (optional): Composite cursor `<updated_at>|<repository>|<pr_number>` for pagination.

Response:
```json
{
  "rows": [
    {
      "repository": "prismalens/gh-workflows",
      "pr_number": 136,
      "state": "open",
      "title": "feat: a prs table",
      "author": "alice",
      "base_ref": "main",
      "head_ref": "feat/prs-table",
      "head_sha": "abc1234",
      "merged_at": null,
      "closed_at": null,
      "updated_at": "2026-09-06T12:00:00.000Z",
      "source": "hook"
    }
  ],
  "next_cursor": "2026-09-06T12:00:00.000Z|prismalens/gh-workflows|136"
}
```

### Worked-Example Consumer Stub (`pr-state.yml`)

Consumer repositories install `.github/workflows/pr-state.yml` as a managed caller stub:

```yaml
name: PR State

on:
  pull_request_target:
    types: [opened, reopened, synchronize, closed, edited, ready_for_review, converted_to_draft]

concurrency:
  group: pr-state-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  pr-state:
    uses: prismalens/gh-workflows/.github/workflows/pr-state.yml@main
    secrets:
      REVIEW_TELEMETRY_TOKEN: ${{ secrets.REVIEW_TELEMETRY_TOKEN }}
```

Key characteristics:
- Runs on `pull_request_target` (with activity types `opened`, `reopened`, `synchronize`, `closed`, `edited`, `ready_for_review`, and `converted_to_draft`) so fork pull requests can report state with secrets access, while remaining safe because **it checks out no code and executes no repository code** (#136).
- Also provides a `workflow_call` entry point so consumer workflows can invoke PR state ingestion directly as a reusable workflow.
- Explicitly maps `REVIEW_TELEMETRY_TOKEN` (`secrets: inherit` fails across organization boundaries).
- Never fails consumer CI: failures emit warnings and exit 0.

## Telemetry reconciliation (`telemetry-reconcile.yml`) (#87)

The telemetry reconciler detects gaps between GitHub Actions workflow runs and the records ingested into the review telemetry database.

### Architecture

Reconciliation runs on a per-repository basis using the caller repository's local `github.token` with `actions: read` and `contents: read` permissions (#87, operator ruling 3944010364).

- **Reusable Workflow (`.github/workflows/telemetry-reconcile.yml`)**:
  - Entry point: `on: workflow_call`.
  - Inputs: `window_hours` (number, optional, default `26` to bridge cron interval boundaries).
  - Secrets: `REVIEW_TELEMETRY_TOKEN` (required).
  - Permissions: `actions: read`, `contents: read`.
  - Queries `GET /api/accounted-runs?repository=<repo>&since=<since>&until=<until>` on the worker.
  - Queries GitHub Actions runs via `gh api --paginate --slurp "repos/${REPO}/actions/workflows/claude-code-review.yml/runs?per_page=100"` and compares them.
  - Excludes cancelled runs that executed zero jobs.
  - Fails red (`exit 1`) with `::error::` annotations if any workflow run in the window is unaccounted for or if the API cannot be reached.

### Worked-Example Consumer Stub (`telemetry-reconcile-caller.yml`)

Consumer repositories install a managed caller stub:

```yaml
name: Telemetry Reconciler

on:
  schedule:
    # 04:23 UTC daily. Off the hour on purpose: GitHub delays cron at peak hours (#44).
    - cron: '23 4 * * *'
  workflow_dispatch:
    inputs:
      window_hours:
        description: 'Hours to look back for reconciliation (default 26 to bridge boundaries)'
        required: false
        default: 26
        type: number

permissions:
  actions: read
  contents: read

jobs:
  reconcile:
    uses: prismalens/gh-workflows/.github/workflows/telemetry-reconcile.yml@main
    with:
      window_hours: ${{ inputs.window_hours || 26 }}
    secrets:
      REVIEW_TELEMETRY_TOKEN: ${{ secrets.REVIEW_TELEMETRY_TOKEN }}
```
