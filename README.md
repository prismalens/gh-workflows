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
    types: [opened, synchronize, ready_for_review, reopened]

# This is a managed caller stub.
# The lane logic lives in prismalens/gh-workflows/.github/workflows/claude-code-review.yml.
# Do not add logic here.

# Concurrency lives in the caller ONLY: a callee sharing the caller's group
# deadlocks the run ("deadlock detected for concurrency group").
concurrency:
  group: claude-code-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    uses: prismalens/gh-workflows/.github/workflows/claude-code-review.yml@main
    secrets: inherit
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write
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
