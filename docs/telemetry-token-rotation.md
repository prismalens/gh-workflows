# Telemetry token rotation

## Overview

The `REVIEW_TELEMETRY_TOKEN` secret authenticates telemetry ingest payloads sent from GitHub Actions review runs to the `review-telemetry` Cloudflare Worker.
It is a single shared secret across all consumers and the Worker.
The Worker secret is write-only in Cloudflare.
You cannot inspect or retrieve the current token from Cloudflare.
Because the secret cannot be read back, partial repairs are impossible.
Every fix or update requires a full rotation across all locations.

On 2026-09-01, a rotation at 03:03Z updated the repository secrets in the `prismalens` organization.
The operator missed `Sumit1993/mage-memory` because it lives in a personal account outside the organization.
Every telemetry ingest from `Sumit1993/mage-memory` failed with HTTP 401 until a second full rotation completed at 17:21Z.
Follow this runbook to rotate the token without leaving any repository behind.

## Secret locations

The secret lives in five places.
It exists in four GitHub repositories and in one Cloudflare Worker.

1. `prismalens/prismalens` (GitHub Actions repository secret)
2. `prismalens/sreforge` (GitHub Actions repository secret)
3. `prismalens/gh-workflows` (GitHub Actions repository secret)
4. `Sumit1993/mage-memory` (GitHub Actions repository secret)
5. `review-telemetry` Cloudflare Worker (Worker secret)

Notice that `Sumit1993/mage-memory` is in a personal account outside the `prismalens` organization.
Do not omit it.

## Rotation order

Always update the GitHub repositories first.
Update the Cloudflare Worker last.

Ingest requests fail closed while secrets do not match.
When you update repositories first, runs that start before the Worker update will fail closed for a few seconds.
Updating the Worker first causes the same outage, but with a longer failure window.
Repositories run workflows continuously, so updating all four repositories before switching the Worker minimizes downtime.

## Step 1: Generate a new token

Generate a random 32-byte hexadecimal token.
Run this command in your terminal:

```bash
NEW_TOKEN="$(openssl rand -hex 32)"
echo "$NEW_TOKEN"
```

Keep this token ready for the next steps.

## Step 2: Update repository secrets

Set the new token on all four repositories.
Run these commands using the GitHub CLI:

```bash
echo "$NEW_TOKEN" | gh secret set REVIEW_TELEMETRY_TOKEN --repo prismalens/prismalens
echo "$NEW_TOKEN" | gh secret set REVIEW_TELEMETRY_TOKEN --repo prismalens/sreforge
echo "$NEW_TOKEN" | gh secret set REVIEW_TELEMETRY_TOKEN --repo prismalens/gh-workflows
echo "$NEW_TOKEN" | gh secret set REVIEW_TELEMETRY_TOKEN --repo Sumit1993/mage-memory
```

Verify that each command exits with status code 0.

## Step 3: Update the Cloudflare Worker secret

The operator must execute the Worker secret command directly.
Automated agent tools refuse interactive secret inputs.
Change to the `worker/` directory in the repository:

```bash
cd worker
```

Run wrangler to write the secret to the Cloudflare Worker:

```bash
echo "$NEW_TOKEN" | npx wrangler secret put REVIEW_TELEMETRY_TOKEN
```

If you prefer interactive input, run:

```bash
npx wrangler secret put REVIEW_TELEMETRY_TOKEN
```

Paste the new token when prompted.
Wrangler will confirm that the secret is uploaded.

## Step 4: Verify ingest across all repositories

Verify that review rounds in all four repositories successfully ingest telemetry without HTTP 401 errors.
The rotation is not proven until a round from each of the four repositories has written a row.

Check recent workflow runs for each repository:

```bash
gh run list --repo prismalens/prismalens --workflow claude-code-review.yml --limit 5
gh run list --repo prismalens/sreforge --workflow claude-code-review.yml --limit 5
gh run list --repo prismalens/gh-workflows --workflow claude-code-review.yml --limit 5
gh run list --repo Sumit1993/mage-memory --workflow claude-code-review.yml --limit 5
```

Inspect the `review / telemetry` job log for the latest run in each repository:

```bash
gh run view <RUN_ID> --repo <REPO> --log --job review
```

Confirm that the telemetry step exits cleanly with exit code 0.
Confirm that no warning annotation containing `HTTP 401` appears in the run.
You can also check the D1 database directly to confirm new telemetry rows are recorded:

```bash
npx wrangler d1 execute review-telemetry --remote --command "SELECT repo, created_at FROM usage_records ORDER BY created_at DESC LIMIT 10;"
```
