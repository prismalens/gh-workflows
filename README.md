# gh-workflows

Canonical GitHub Action CI and review-lane workflows for `prismalens` ecosystem repositories.

## Overview & Contract

This repository (`prismalens/gh-workflows`) is the **single source of truth** for review-lane GitHub Actions workflows across all consumer repositories:

- `prismalens/prismalens`
- `prismalens/sreforge`
- `Sumit1993/mage-memory`

### Key Architectural Rules

1. **Canonical Copy Sync & Reusable Callees**: Reusable workflow callees live in `.github/workflows/` and can be invoked by consumer repos via `workflow_call` (see [prismalens#403](https://github.com/prismalens/prismalens/issues/403)). Master copies remain in `canonical/` during transition.
2. **Do Not Edit Consumers Directly**: **NEVER** edit review workflows (`claude-code-review.yml`, `claude.yml`) directly in a consumer repository. Any manual modifications in consumer repos introduce drift and will be flagged by `scripts/check-drift.sh`.
3. **Secrets are Per-Consumer-Repo**: Repository secrets (such as `CLAUDE_CODE_OAUTH_TOKEN`) are configured individually on each consumer repository and **never** live in this repository.

---

## Canonical Workflows & Rulesets

| Path | Purpose |
| --- | --- |
| [`canonical/claude-code-review.yml`](canonical/claude-code-review.yml) | Canonical advisory Claude Code Review workflow (runs on same-repo PRs, opens inline finding threads). |
| [`canonical/claude.yml`](canonical/claude.yml) | Canonical `@claude` mention response workflow. |
| [`canonical/README-pr-title-pattern.md`](canonical/README-pr-title-pattern.md) | Guide for Conventional Commit PR title validation (`pr-title.yml`) and merge queue patterns. |
| [`rulesets/merge-queue-rule.json`](rulesets/merge-queue-rule.json) | Canonical GitHub Merge Queue ruleset configuration. |
| [`rulesets/README.md`](rulesets/README.md) | Documentation for applying repository rulesets via GitHub API. |
| [`consumers.json`](consumers.json) | Registry mapping consumer repositories to their assigned canonical workflows. |

---

## Reusable lanes (workflow_call)

Reusable workflow callees defined in `.github/workflows/claude-code-review.yml` and `.github/workflows/claude.yml` allow consumer repositories to invoke central Claude CI lane logic via GitHub Actions `workflow_call`. Instead of maintaining duplicated copies of full lane definitions across repos, consumer repositories maintain thin caller stubs that reference these reusable workflows.

### Worked-Example Consumer Stub

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

> **Note**: Canonical copies in `canonical/` remain in place for `prismalens/prismalens` and `prismalens/sreforge` until those repositories convert to `workflow_call` caller stubs.

### `@main` Pinning Rationale

Caller stubs pin callees to `@main` (`uses: prismalens/gh-workflows/.github/workflows/<filename>@main`) to enable **live inheritance**. Any fix or optimization committed to canonical workflows in `gh-workflows` main branch automatically applies to all consumer repos on their next workflow run without requiring multi-repo copy-sync PRs.

---

## Scripts & Operations

### 1. Check Workflow Drift Across Consumers

Runs a check comparing `canonical/` workflows against live consumer repository copies fetched via the GitHub API:

```bash
bash scripts/check-drift.sh
```

- Prints `IN-SYNC` when the consumer workflow matches `canonical/`.
- Prints `DRIFT` alongside a unified diff when differences exist.
- Prints `MISSING` if a consumer lacks a configured workflow.
- Exits with `0` if all consumer workflows are in sync, or `1` if any drift or missing files are detected.

### 2. Sync Canonical Workflows to a Consumer Repo

Creates a pull request on the specified consumer repository updating its `.github/workflows/` to match canonical:

```bash
bash scripts/sync-consumer.sh <owner/repo>
```

Example:
```bash
bash scripts/sync-consumer.sh prismalens/sreforge
```

> **Note**: `sync-consumer.sh` requires a clean working directory in `gh-workflows` before executing. It creates a sync branch named `sync-review-workflows-<short-sha>` in a temporary clone, commits with `ci: sync review workflows from prismalens/gh-workflows@<short-sha>`, pushes, and opens a PR via `gh pr create`.

---

## Open Follow-ups

- **`workflow_call` conversion**: Tracked in [prismalens#403](https://github.com/prismalens/prismalens/issues/403).
