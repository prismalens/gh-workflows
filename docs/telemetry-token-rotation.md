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
```

Do not echo it. The value stays in the shell variable and goes into each secret from
there. A token printed to a terminal is in scrollback, and this one opens the ingest
route for four repositories.

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

Inspect the telemetry job's log for the latest run in each repository. The ingest step runs
in the `telemetry` job, not `review`, and `--job` takes a numeric id rather than a name, so
resolve the id first:

```bash
RUN_ID=<run id from the list above>
REPO=<owner/name>
TELEMETRY_JOB_ID="$(gh run view "$RUN_ID" --repo "$REPO" --json jobs \
  --jq '.jobs[] | select(.name == "telemetry") | .databaseId')"
gh run view "$RUN_ID" --repo "$REPO" --job "$TELEMETRY_JOB_ID" --log
```

## Step 5: Prove it, per repository

A clean exit proves nothing. The telemetry step also exits 0 when the URL or token is
absent, when the URL is not https, when the POST never completes, and when the endpoint
answers with a non-2xx status. Each of those paths writes a warning and returns 0 by
design, so that a telemetry failure never fails a review.

The only proof is a row. Query the store for one row per repository written after the
rotation:

```bash
cd worker && npx wrangler d1 execute review-telemetry --remote --json --command \
  "SELECT repository, COUNT(*) AS n, MAX(recorded_at) AS last
   FROM usage_records
   WHERE recorded_at > '<rotation timestamp, ISO 8601 UTC>'
   GROUP BY repository"
```

The columns are `repository` and `recorded_at`. There is no `repo` or `created_at` column
on `usage_records`; an earlier draft of this runbook used those names and the query would
have errored rather than verified anything.

The rotation is proven when **every repository that runs the lane appears in that result**.
A repository missing from it has not written since the rotation, and there are two reasons
for that which look identical here: its secret is wrong, or it has had no reviewable round.
Separate them by checking whether the repository has had a non-dependabot round at all in
the window. A dependabot pull request receives no secrets on `pull_request`, so its runs
can never write a row and can never confirm anything.

Do not treat the absence of an `HTTP 401` annotation as proof. A repository whose secret is
missing entirely never reaches the request, so it produces no 401 either.
