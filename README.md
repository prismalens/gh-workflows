# gh-workflows

Canonical GitHub Actions workflows and composite actions for `prismalens` ecosystem repositories.

## Membership Rule

If a defect fixed in one repo's copy would need the same fix in another's, the file belongs here.

---

## Reusable Lanes (`workflow_call`)

Reusable workflow callees live in `.github/workflows/` and are invoked by consumer repositories via `workflow_call`.

### Callees

- [`.github/workflows/claude-code-review.yml`](.github/workflows/claude-code-review.yml) — behaviour: [docs/review-lane.md](docs/review-lane.md)
- `.github/workflows/claude.yml`
- `.github/workflows/dependabot-auto-merge.yml`
- `.github/workflows/dependabot-auto-merge-caller.yml` — this repository's own caller stub for the auto-merge callee

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

See [docs/review-lane.md](docs/review-lane.md) for review lane inputs, org defaults (`.github/claude-review-defaults.yml`), per-repo configuration (`.github/claude-review.yml`), four-layer precedence, model escalation, consumer stub configuration, summon grammar, incremental review, step summaries, thread resolution, and fork handling.

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

Minor and patch updates are grouped into a single PR (`github-actions`). Major updates are excluded from grouping and open as individual PRs for manual human review.

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
