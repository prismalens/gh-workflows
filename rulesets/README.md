# Repository Rulesets

This directory contains reusable GitHub Repository Ruleset definitions for `prismalens` ecosystem repositories.

## Merge Queue Rule (`merge-queue-rule.json`)

`merge-queue-rule.json` defines the canonical GitHub Merge Queue configuration for trunk branch protection.

### Configuration Specification

- **`merge_method`**: `SQUASH` (all PRs squash-merge into trunk)
- **`grouping_strategy`**: `ALLGREEN` (require all checks green before merging group)
- **`max_entries_to_build`**: `5`
- **`max_entries_to_merge`**: `5`
- **`min_entries_to_merge`**: `1`
- **`min_entries_to_merge_wait_minutes`**: `1`
- **`check_response_timeout_minutes`**: `60`

### Where It Goes & How It Is Applied

Rulesets on `prismalens` repositories are enforced via GitHub Repository Rulesets (e.g. `main protection` ruleset). They are managed directly through the GitHub REST API (`gh api`) and do not live as in-tree files within consumer repositories.

To add or update this rule in a target repository's ruleset:

1. Fetch the existing ruleset ID for the repository:
   ```bash
   gh api repos/<owner>/<repo>/rulesets
   ```

2. Include `merge-queue-rule.json` in the `rules` array when updating the ruleset via GitHub API:
   ```bash
   gh api -X PUT repos/<owner>/<repo>/rulesets/<ruleset_id> \
     --input updated_ruleset.json
   ```
