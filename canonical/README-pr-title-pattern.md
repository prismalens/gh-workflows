# Conventional Commit PR Title Pattern for Merge Queues

This document describes the PR title validation pattern used across `prismalens` repositories.

> **Note**: Unlike `claude-code-review.yml` and `claude.yml`, `pr-title.yml` is **not** copied verbatim to consumer repositories. Allowed commit types, scopes, and status check requirements differ per repository (e.g. `eval` type in `sreforge`). Consumers adapt their own `pr-title.yml` based on this pattern.

---

## Pattern Overview

### 1. Source Comment from `prismalens/prismalens`'s `pr-title.yml`

```yaml
# Enforce that PR titles follow Conventional Commits. The repo squash-merges, so a
# PR's title becomes the commit subject on the trunk (`main`). Keeping titles
# conventional keeps history readable and changelog-ready.
#
# This validates the PR TITLE, not local branch commits (those get squashed away) —
# which is why a commit-msg hook (husky/commitlint) would be the wrong layer for a
# branch-protected, squash-merge repo.
#
# This is wired as a REQUIRED status check on `main` by repository ruleset
# 18441175, alongside `CI gate`, so a non-conventional title blocks merge.
# The ruleset is edited directly through the GitHub API; there is no
# in-tree file that defines it. `synchronize` is included because a required check
# must run on each new push to stay green.
```

---

## Key Design Rules

### Single Job Structure

- Define **only one job** in `pr-title.yml` (e.g. `validate`), publishing a single status check name (e.g. `Validate PR title (conventional commits)`).
- When supporting multiple triggers (such as `pull_request`, `pull_request_target`, or `merge_queue`), use **step-level `github.event_name` conditions** or single-job routing rather than creating duplicate job definitions.

### Why Two Same-Named Jobs is a Defect

Having two jobs with the same name across separate workflow files or within the same workflow for different event triggers is a severe structural defect:
1. **Status Check Collision**: GitHub Actions status checks are matched by job context name (e.g. `Validate PR title (conventional commits)`). Two same-named jobs register competing status checks for the commit status API.
2. **Vacuous / Overwritten Statuses**: One job run can overwrite or race another, leading to required status checks getting stuck in pending or passing vacuously without executing validation against the actual target PR metadata.
3. **Merge Queue Failures**: Under GitHub Merge Queue, entries run under `merge_group` events. If a workflow defines separate jobs for `pull_request` vs `merge_group` with identical job names, GitHub branch protection cannot distinguish between them, causing queue evaluations to fail or stall.
