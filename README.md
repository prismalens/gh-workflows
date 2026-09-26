# gh-workflows

Canonical GitHub Actions workflows and composite actions for `prismalens` ecosystem repositories.

## Membership Rule

If a defect fixed in one repo's copy would need the same fix in another's, the file belongs here.

---

## Reusable Lanes (`workflow_call`)

Reusable workflow callees live in `.github/workflows/` and are invoked by consumer repositories via `workflow_call`.

### Callees

- [`.github/workflows/claude-code-review.yml`](.github/workflows/claude-code-review.yml)
- `.github/workflows/claude.yml`
- [`.github/workflows/review-findings-sweep.yml`](.github/workflows/review-findings-sweep.yml) — the review-findings ingest sweep (`#47`)
- [`.github/workflows/pr-state.yml`](.github/workflows/pr-state.yml) — records PR state for the Console's open-findings counts, via `pull_request_target`, and checks nothing out (`#211`)
- `.github/workflows/dependabot-auto-merge.yml`
- `.github/workflows/dependabot-auto-merge-caller.yml` — this repository's own caller stub for the auto-merge callee

### This Repository's Own CI

`.github/workflows/tests.yml` verifies the callees above, which run in consumer repositories and
are not otherwise checked before they ship. It runs on every pull request and on pushes to
`main`. Two of its jobs:

- `test` extracts the real shell and Python out of the callees and runs it, then runs `actionlint`
  at a pinned version.
- `dashboard` builds the SPA in `dashboard/`: `npm ci`, then `npm test` for the honesty rules, the
  read-route contract and the routes, then `npm run build`, which typechecks and bundles.
  `dashboard/dist` is gitignored, so this job is the only thing that catches a broken build.

None of its jobs is a required check. Nothing in this repository is enforced by branch protection
or a ruleset; see [AGENTS.md](AGENTS.md).

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
    # Verb exclusion: the review lane owns all four of these phrasings, and its own
    # caller `if:` admits exactly this list. Every one needs its own check, because
    # none contains another as a substring — `@claude full review` does not contain
    # `@claude review`. `contains()` on a null body is false, so `issues` and
    # `pull_request_review` events pass through untouched.
    # Review bodies stay with the mention lane: no other lane subscribes to pull_request_review.
    if: >-
      !(
        contains(github.event.comment.body, '@claude review') ||
        contains(github.event.comment.body, '@claude full review') ||
        contains(github.event.comment.body, '@claude pause') ||
        contains(github.event.comment.body, '@claude resume')
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
4. **Mention Lane Excludes Owned Verbs**: The `claude.yml` caller stub must carry a caller-level `if:` excluding comment bodies that contain `@claude review`, `@claude full review`, `@claude pause` or `@claude resume`. All four belong to the review lane; without the exclusion each such comment fires two lanes on the same PR. The list is not a judgement call — it is the same four literals the review lane's own caller `if:` admits, so a verb added there is added here in the same change. Exact expression: the Mention Lane worked example above.

   The exclusion is a verb list and cannot cover the review lane's fifth admitted surface. That lane also takes **every** `pull_request_review_comment` on an open pull request, with no verb required, because an in-thread reply is what triggers a verification round. So a bare `@claude, what does this do?` left in a review thread still fires both lanes: a verify round that re-checks the unresolved threads, and a mention answer. Which lane should own that comment is an open question in [#160](https://github.com/prismalens/gh-workflows/issues/160) and is deliberately not answered here, because the two readings lead to different stubs and neither is recorded anywhere as intended.
5. **Pin `branches` on `pull_request`**: Every stub that triggers on `pull_request` pins `branches: [main]`, so covering a future `release/*` branch is a decision someone makes, not an accident.
6. **Comment Triggers Need a Concurrency Fallback and a Junk Group**: The moment a stub gains `issue_comment` / `pull_request_review_comment` triggers, two things become load-bearing in the group key. It must fall back to `github.event.issue.number`, because `github.event.pull_request.number` is empty on `issue_comment` and without the fallback the group collapses to the constant `claude-code-review-`: one global group in which any PR's summon cancels every other PR's in-flight run. And the lane's own emissions must divert to a per-run junk group, because concurrency is allocated at run creation, before any job `if:` runs, so the callee's admission gate cannot keep them out: a `claude[bot]` verdict comment took the pending seat and cancelled the queued human reply four times out of four (`prismalens/gh-workflows#12`). Both, together:

   ```yaml
   group: >-
     ${{ (github.event.comment.user.type == 'Bot'
          || (github.event_name == 'issue_comment' && !github.event.issue.pull_request))
         && format('claude-code-review-junk-{0}', github.run_id)
         || format('claude-code-review-{0}', github.event.pull_request.number || github.event.issue.number) }}
   ```

   Copy the group and the guard from a consumer stub that is already running, never from prose. A stub written from a description reproduces whatever the description last forgot.
7. **Cancel Automatic Rounds Only**: On a lane that takes both `pull_request` and comment triggers, use `cancel-in-progress: ${{ github.event_name == 'pull_request' && github.event.action != 'labeled' && github.event.action != 'unlabeled' }}`: a summon never cancels an in-flight automatic round; it queues behind it. A push still supersedes anything in the group, including a summon. A label event never cancels a running round either; it queues behind it (#189).

   What that group does under load is the rest of the scheduling contract, and every part of it is a condition in the stub above or in `claude-code-review.yml`. GitHub's own wording, under [`concurrency`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency): "there can be at most one running job or workflow in a concurrency group at any time... any existing `pending` job or workflow in the same concurrency group will be canceled and the new queued job or workflow will take its place."

   So one seat and one waiting room. N in-thread replies fire N runs into that group, and every arrival after the second evicts the one waiting; those runs conclude `cancelled` with zero jobs, which reads like breakage and is not, because one verify round re-checks every unresolved thread and the survivor covers what the evicted runs would have. The cost is latency and invisibility, never coverage. A push supersedes anything queued, summons included, so the common cycle of fix, push, reply kills the round the reply asked for: the reliable order is fix, push, reply, then exactly one `@claude review` after the last push. And the seat is held for up to `timeout-minutes: 30` against a measured 5.03 minute mean and 12.72 peak (`prismalens/gh-workflows#63`), during which nothing evicts a hung run because `cancel-in-progress` is false for comment events.
8. **Nothing Reviews a Draft, By Any Trigger**: The review stub carries a bare
   `if: github.event.pull_request.draft != true`, not a form scoped to `pull_request`. The two
   comment events differ under it and the difference is the whole rule. `pull_request_review_comment`
   carries a `pull_request` object, so a reply on a draft is stopped at the stub and no run is
   spent. `issue_comment` does not, so `.draft` is null and a summon reaches the callee, which
   skips its own `review` job on the same fact and answers with a `draft` verdict on the liveness
   comment rather than silence. Marking the pull request ready is what collects the work, and the
   lane then takes the whole diff in one round. Story: `prismalens/gh-workflows#153`.
9. **Admission is effective repository permission, not `author_association`**: Comment events in both lanes are admitted only when the acting account holds `admin` or `write` on the repository, checked live in the `admit` composite action. `author_association` is banned from admission: it is repo-scoped and payload-dependent, and it reported `CONTRIBUTOR` in the webhook for a maintainer whose REST record said `MEMBER`, so replies on `prismalens/prismalens` were never admitted. A failed check is red, never silently open and never silently closed. Story: `prismalens/gh-workflows#20`.
10. **Oversize Rounds Refuse, Never Trim**: A round whose reviewable lines (additions plus modified hunk lines, after path and file-size filtering) exceed the caller's `max_reviewable_lines` cap posts nothing inline. The liveness comment and the telemetry record both carry `refused-size` — with the reviewable-line count and the cap — in place of a review, and `@claude full review` overrides the cap for that one round. `max_file_lines` is the companion per-file cap: a single file above it is marked `oversized` in `.claude-review-manifest.json` and excluded from the diff and the line count, exactly like a path-filtered file. Both are `workflow_call` inputs with workflow defaults, overridable per repo in `.claude-review.yml`; 0 disables either cap. Story: #105.
11. **Liveness Marker Records Who Paused**: An explicit `@claude pause` sets `paused=1` in the marker and now also `paused_by=<login>` beside it — the account that sent it. Recorded once, at the moment the pause takes effect, and carried forward unchanged by a later push or a repeated `@claude pause` while already paused. The automatic pause once `auto_pause_rounds` is reached (verdict `auto-paused`) is a different state and never sets `paused_by`; nobody requested it. A pause is soft, and deliberately so: it stops the automatic round, and `@claude review`, `@claude full review` and `@claude resume` all lift it. It lives at the comment layer, which is per-round and ephemeral, so a comment-driven stop would be liftable by the next comment — which is a pause, not a stop. The stop is `admission: off` in repo config or a per-pull-request skip label, each reversed by a deliberate act that is not a comment. What a pause must never do is vanish: a push or a verb-less in-thread reply carries `paused=1` forward rather than clearing it, which is the #178 report. Stories: #124, #178, ruling in #189.
12. **Review Context Reads Linked Issues and Failing CI Logs, All Untrusted**: Beyond the diff, a round resolves `Closes #N` / `Fixes #N` / `Refs #N` / bare `#N` in the PR body's first paragraph and reads each issue's title, body, labels and newest ruling-shaped comment; it also reads the tail of the log for any GitHub Actions check already failing on this head (a third-party check contributes only its name and conclusion, never output). Both are read into the prompt as UNTRUSTED EVIDENCE about the code, the same rule already applied to the PR body itself, never as instructions to the model. Stories: #143, #145.
13. **`review.level` Sets Effort Per Round, Never Which Code Is Read**: A per-repo `.claude-review.yml` key, resolved through the same precedence as every other config value. Workflow default is `medium`, which is byte-identical to the review lane's behaviour before this key existed. `high` runs six review agents instead of four (two extra Opus agents: cross-boundary interaction with unchanged code, and contracts/schemas). `medium` and `high` are the only accepted values this release; `low` is schema-rejected on purpose, so a knob that could lower review depth is not reachable yet. A changed file matching `escalation_paths` floors the round at `medium` — never a ceiling — recorded as `level_source: escalation` (`config` otherwise) alongside `level` in the telemetry record. Level is orthogonal to model: a `--model` summon never changes it, and there is no summon-side override. It has no effect on `max_reviewable_lines` or `refused-size`, and it does not run on a verify round. Story: #101.
14. **A Skip Never Overwrites a Real Verdict on the Same Head**: The liveness comment is upserted, so on its own an auto-paused or otherwise-skipped round finishing after a real review would replace it with the absence of one — the last writer wins on comment ordering, not on which run actually knows more. The marker's `sha=` is the test: it only ever advances on posted review output, so `sha=` equal to the round's own head means a real verdict already stands there, and the write is withheld. This does not order two rounds in general; it stops the one case where replacing the comment is strictly a loss. `round_ordinal` and any lane event still fire on a withheld round — a withheld comment is not a skipped round. The guard protects the verdict, never the marker beside it: an explicit `@claude pause` or `@claude resume` is a state transition, and the marker is the only place that state lives, so withholding it dropped the instruction rather than preserving anything — a pause on an already-reviewed head never wrote `paused=1`, and a resume there never cleared it. A transition therefore always writes, carrying the standing verdict text under the new marker and rebuilding a single `_Lane state:` line beneath it. A round that changes no pause state is still withheld. Stories: #149, #191.
15. **Admission Is a Property of the Key**: `review.admission` in `.github/claude-review.yml` at the base ref decides when the lane reviews: `auto` (default), `label` or `off`.
    Config resolves through five layers, broadest first: workflow, org, repo, label, comment. Whether a narrower layer may override a key is a property of the key, not of the layer: `default_model` yields to a `--model` summon, `admission` does not.
    `off`: nothing reviews, comments or records a marker; the lane event is `admission-off`. Reversed by a commit to the base branch.
    `label`: only pull requests carrying `claude_review` are reviewed; others get an `awaiting-label` verdict. Reversed by applying the label, with no push needed once the stub sends `labeled`, or by a `@claude review` or `@claude full review` from someone with write access, which runs the round and applies the label (#219).
    `claude_review_skip` keeps the lane off one pull request under any admission (`skip-label`). Reversed by removing it.
    `@claude pause` stays the soft, comment-layer form (principle 11). Summons and in-thread replies are refused under all three stops.
    Consumer stubs must list `labeled, unlabeled` in `pull_request.types` and carry the principle-7 `cancel-in-progress`. Without them `auto` and `off` are unaffected, and a label takes effect at the next push or `@claude review`.
    `scripts/setup-repo.sh` creates both labels. Stories: #189, #178, #124.

Everything else about the review lane — inputs, per-repo configuration (`.github/claude-review.yml`), shared defaults (an optional top-level `extends: owner/repo[@ref]` in that file, read at the base ref, which makes the named repository's `.github/claude-review.yml` the base layer under this repository's own keys, one level deep), four-layer precedence, model escalation, summon grammar, incremental review, step summaries, liveness verdicts, thread resolution and fork handling — is read out of [`.github/workflows/claude-code-review.yml`](.github/workflows/claude-code-review.yml), which is the only source of truth for it. A prose copy of that behaviour used to live in `docs/review-lane.md`; it was deleted because it drifted, and its worked-example consumer stub had spent ten days telling new consumers to build the concurrency group that `prismalens/gh-workflows#12` exists to prevent. Read the workflow, and copy stubs from a repository that is running one.

### Worked-Example Consumer Stub (Review Findings Sweep)

[`.github/workflows/review-findings-sweep.yml`](.github/workflows/review-findings-sweep.yml) enumerates `claude[bot]` review threads with the default read-only `GITHUB_TOKEN` and POSTs them to the review-telemetry Worker's findings route (`#47`). It is a `workflow_call` callee, so a consumer needs its own scheduled caller stub. gh-workflows is excluded structurally by the callee's own job `if:` and never calls this workflow itself, because it hosts no Claude lane.

```yaml
# This is a managed caller stub.
# Logic lives in prismalens/gh-workflows/.github/workflows/review-findings-sweep.yml.
# Do not add logic here.

name: Review Findings Sweep

on:
  schedule:
    # Daily, off the hour on purpose: GitHub delays cron at peak hours (#44).
    - cron: '17 5 * * *'
  workflow_dispatch:
    inputs:
      full_history:
        description: 'Ignore the update window and sweep every pull request in this repository'
        required: false
        default: false
        type: boolean

jobs:
  sweep:
    uses: prismalens/gh-workflows/.github/workflows/review-findings-sweep.yml@main
    with:
      full_history: ${{ inputs.full_history || false }}
    # explicit mapping, not `secrets: inherit` — Sumit1993/mage-memory sits outside the
    # prismalens org, and inherit does not cross that boundary (Stub Rule 3, above).
    secrets:
      REVIEW_TELEMETRY_URL: ${{ secrets.REVIEW_TELEMETRY_URL }}
      REVIEW_TELEMETRY_TOKEN: ${{ secrets.REVIEW_TELEMETRY_TOKEN }}
    # The callee's own job permissions, granted here because a `workflow_call` callee can only
    # downgrade what its caller passes (AGENTS.md, "A callee permission is a caller change").
    permissions:
      contents: read
      pull-requests: read
      id-token: write
```

Both secrets are `required: false` on the callee: a consumer that has not opted into review-findings ingest still runs the workflow, and the sweep step skips itself with a plain notice rather than failing the run, the same contract `claude-code-review.yml`'s own telemetry job already uses for `REVIEW_TELEMETRY_URL` / `REVIEW_TELEMETRY_TOKEN`. A normal (non-`full_history`) run only looks back `window_days` (default 3), wider than the daily cadence on purpose so a delayed or missed run cannot drop a day.

### Worked-Example Consumer Stub (Telemetry Health)

[`.github/workflows/telemetry-health.yml`](.github/workflows/telemetry-health.yml) reports how many
of a repository's recent workflow runs never produced a telemetry row, so a gap in the pipeline
shows up as a Worker-side report rather than silence. It skips itself entirely on
`prismalens/gh-workflows`, the repository that hosts it.

```yaml
# This is a managed caller stub.
# Logic lives in prismalens/gh-workflows/.github/workflows/telemetry-health.yml.
# Do not add logic here.

name: Telemetry Health

on:
  schedule:
    # Daily, off the hour on purpose: GitHub delays cron at peak hours (#44).
    - cron: '41 6 * * *'
  workflow_dispatch:
    inputs:
      window_days:
        description: 'Number of days to look back for workflow runs and health reporting'
        required: false
        default: 7
        type: number

# The schedule and a hand-run dispatch can otherwise overlap, and each run POSTs its own
# report for the same recent window. The Worker inserts every report into `health_reports`
# without deduplication, so two overlapping runs mean two rows describing one window and a
# reader cannot tell them from two genuine reports. Serialised here rather than deduped
# there, because the caller is the only place that knows a run is a repeat of one already
# in flight. `cancel-in-progress: false` on purpose: the run already talking to the Worker
# finishes, and the newer one waits rather than replacing it. Story: #177.
concurrency:
  group: telemetry-health-${{ github.repository }}
  cancel-in-progress: false

jobs:
  health:
    uses: prismalens/gh-workflows/.github/workflows/telemetry-health.yml@main
    with:
      window_days: ${{ inputs.window_days || 7 }}
    # explicit mapping, not `secrets: inherit` — Sumit1993/mage-memory sits outside the
    # prismalens org, and inherit does not cross that boundary (Stub Rule 3, above).
    secrets:
      REVIEW_TELEMETRY_URL: ${{ secrets.REVIEW_TELEMETRY_URL }}
      REVIEW_TELEMETRY_TOKEN: ${{ secrets.REVIEW_TELEMETRY_TOKEN }}
    # The callee's own job permissions, granted here because a `workflow_call` callee can only
    # downgrade what its caller passes (AGENTS.md, "A callee permission is a caller change").
    permissions:
      actions: read
      contents: read
      id-token: write
```

Both secrets are `required: false` on the callee, the same consent-first contract as the sweep and
the review lane's own telemetry job: a consumer that has not opted in still runs, and the report
step skips itself with a Step Summary line rather than failing the run.

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

A consumer repository typically pins the PR title status check name in its own rulesets (branch protection rules); gh-workflows itself has no such ruleset (see [AGENTS.md](AGENTS.md)). Reusable workflows (`workflow_call`) automatically rename check runs to `"caller-job-name / callee-job-name"` (e.g. `validate / Validate PR title`), breaking a consumer's pinned required status check name. Composite actions execute within the caller's job context, keeping the check run name exact.

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
- `actions/setup-node`
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

Minor and patch updates are grouped into a single PR (`github-actions`). Major updates are excluded from grouping and open as individual PRs for manual human review.

Consumer repositories can invoke `.github/workflows/dependabot-auto-merge.yml` to automatically merge grouped minor and patch action bumps once required status checks pass.

---

## Review telemetry

`worker/` is the Cloudflare Worker that ingests one record per review round into D1 and serves the
read routes behind Cloudflare Access. `dashboard/` is the SPA that reads them, served by that same
Worker from its `[assets]` binding. `dashboard/dist` is gitignored, so a deploy builds it first;
`dashboard/README.md` has the dashboard commands and deployment details. `worker/README.md` documents
the Cloudflare D1 migrations workflow and Worker operations.

---

## Consumer Repositories

The following consumer repositories use shared CI from this repository (replacing `consumers.json`):

- `prismalens/prismalens`
- `prismalens/sreforge`
- `Sumit1993/mage-memory`

---

## Copy-Sync Retirement

The copy-sync mechanism (`canonical/`, `scripts/sync-consumer.sh`, `scripts/check-drift.sh`, `consumers.json`) is retired. Reusable workflows (`workflow_call`) and composite actions make workflow drift structurally impossible for shared CI lanes across consumer repositories.
