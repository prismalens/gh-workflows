#!/usr/bin/env bash
# Rotate REVIEW_TELEMETRY_TOKEN across every GitHub repo secret and the Cloudflare Worker.
# The Worker secret is write-only and cannot be read back, so a partial rotation leaves
# ingest failing closed wherever the old token still lives. GitHub repos first, Worker
# last, because repos run continuously and a repo-first order minimises the outage
# window. Runbook and the 2026-09-01 incident this codifies: #156.
set -euo pipefail

# The token is piped on stdin everywhere it is set; -x would echo it to trace output.
case "$-" in *x*) echo "refusing to run with -x set: it would trace the token" >&2; exit 1 ;; esac

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORKER_DIR="$SCRIPT_DIR/../worker"

DRY=0
SKIP_WORKER=0
# The 2026-09-01 incident missed Sumit1993/mage-memory because it lives outside the
# prismalens organisation; it stays in the default list on purpose.
REPOS=(prismalens/prismalens prismalens/sreforge prismalens/gh-workflows Sumit1993/mage-memory)
REPOS_OVERRIDDEN=0

usage() {
  cat <<'EOF'
Usage: rotate-telemetry-token.sh [--repo OWNER/NAME]... [--dry-run] [--skip-worker]

  --repo OWNER/NAME   A repository to rotate. Repeatable; replaces the default
                      list on first use.
  --dry-run           Preflight and report only. Generates and writes nothing.
  --skip-worker       Rotate the GitHub repository secrets only.

Default repos: prismalens/prismalens prismalens/sreforge prismalens/gh-workflows
Sumit1993/mage-memory.

Order: every repository, then the Cloudflare Worker. On a mid-run failure the
script stops before the Worker and reports which repos already hold the new
token and which do not.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$REPOS_OVERRIDDEN" -eq 0 ] && { REPOS=(); REPOS_OVERRIDDEN=1; }
      REPOS+=("${2:-}"); shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --skip-worker) SKIP_WORKER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ ${#REPOS[@]} -gt 0 ] || { echo "no repos to rotate" >&2; exit 2; }

say() { printf '%s\n' "$*"; }

# --------------------------------------------------------------- preflight
# Nothing is generated until every check below passes, so a preflight failure
# always leaves the system exactly as it found it.
say "preflight"
PREFLIGHT_FAILED=0
FAILING_REPOS=()

if gh auth status >/dev/null 2>&1; then
  say "  ok    gh auth status"
else
  say "  FAIL  gh auth status"
  PREFLIGHT_FAILED=1
fi

for r in "${REPOS[@]}"; do
  if gh api "repos/$r/actions/secrets/public-key" >/dev/null 2>&1; then
    say "  ok    $r (can write repo secrets)"
  else
    say "  FAIL  $r (repos/$r/actions/secrets/public-key unreadable)"
    FAILING_REPOS+=("$r")
    PREFLIGHT_FAILED=1
  fi
done

if command -v openssl >/dev/null 2>&1; then
  say "  ok    openssl present"
else
  say "  FAIL  openssl not found"
  PREFLIGHT_FAILED=1
fi

if [ "$SKIP_WORKER" -eq 0 ]; then
  # Running Wrangler through npx can download the latest release on demand when
  # worker/node_modules is absent, so an unpinned, unvalidated version would run
  # against the production Worker secret (CR #173, thread 4000816186, CWE-494).
  # The pinned local binary is used explicitly instead, everywhere Wrangler runs
  # in this script.
  WRANGLER_BIN="$WORKER_DIR/node_modules/.bin/wrangler"
  if [ -x "$WRANGLER_BIN" ]; then
    say "  ok    worker/node_modules/.bin/wrangler present"
  else
    say "  FAIL  worker/node_modules/.bin/wrangler missing -- run npm ci in worker/ first"
    PREFLIGHT_FAILED=1
  fi

  if [ -x "$WRANGLER_BIN" ] && (cd "$WORKER_DIR" && "$WRANGLER_BIN" whoami >/dev/null 2>&1); then
    say "  ok    wrangler whoami (worker/)"
  elif [ -x "$WRANGLER_BIN" ]; then
    say "  FAIL  wrangler whoami (worker/)"
    PREFLIGHT_FAILED=1
  fi
fi

if [ "$PREFLIGHT_FAILED" -eq 1 ]; then
  say ""
  say "preflight failed, nothing changed."
  if [ ${#FAILING_REPOS[@]} -gt 0 ]; then
    say "failing repos: ${FAILING_REPOS[*]}"
  fi
  exit 1
fi
say ""

if [ "$DRY" -eq 1 ]; then
  say "DRY RUN: preflight passed. Would rotate: ${REPOS[*]}"
  if [ "$SKIP_WORKER" -eq 0 ]; then
    say "DRY RUN: would then update the Cloudflare Worker secret."
  fi
  exit 0
fi

# ------------------------------------------------------------------ rotate
START_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NEW_TOKEN=$(openssl rand -hex 32)

ROTATED=()
FAILED_REPO=""
for r in "${REPOS[@]}"; do
  say "rotating $r"
  if ! printf '%s' "$NEW_TOKEN" | gh secret set REVIEW_TELEMETRY_TOKEN --repo "$r"; then
    say "  FAILED to set the secret"
    FAILED_REPO="$r"
    break
  fi
  UPDATED=$(gh api "repos/$r/actions/secrets/REVIEW_TELEMETRY_TOKEN" --jq .updated_at 2>/dev/null || true)
  if [ -z "$UPDATED" ] || [[ "$UPDATED" < "$START_TIME" ]]; then
    say "  set, but could not confirm updated_at (got '${UPDATED:-empty}')"
    FAILED_REPO="$r"
    break
  fi
  say "  confirmed updated_at=$UPDATED"
  ROTATED+=("$r")
done

if [ -n "$FAILED_REPO" ]; then
  NOT_ROTATED=("$FAILED_REPO")
  # Everything after the failed repo in the ordered list is also not rotated.
  seen_failed=0
  for r in "${REPOS[@]}"; do
    if [ "$seen_failed" -eq 1 ]; then
      NOT_ROTATED+=("$r")
    fi
    [ "$r" = "$FAILED_REPO" ] && seen_failed=1
  done
  say ""
  say "STOPPED before the Worker. This is the 2026-09-01 split-state failure mode:"
  say "  rotated:     ${ROTATED[*]:-none}"
  say "  not rotated: ${NOT_ROTATED[*]}"
  say ""
  say "The token now differs across repos. Fix the failure above, then either:"
  say "  1. re-run the whole rotation (a fresh token overwrites every repo, so the"
  say "     already-rotated ones are not left on a different value): scripts/rotate-telemetry-token.sh"
  say "  2. or finish by hand: generate one token and set it on the remaining repos,"
  say "     then re-run this script for the already-rotated ones plus the Worker so"
  say "     every location ends on the same value:"
  for nr in "${NOT_ROTATED[@]}"; do
    say "       printf '%s' \"\$NEW_TOKEN\" | gh secret set REVIEW_TELEMETRY_TOKEN --repo $nr"
  done
  exit 1
fi
say ""

# -------------------------------------------------------------- the Worker
if [ "$SKIP_WORKER" -eq 0 ]; then
  say "rotating the Cloudflare Worker"
  if (cd "$WORKER_DIR" && printf '%s' "$NEW_TOKEN" | "$WRANGLER_BIN" secret put REVIEW_TELEMETRY_TOKEN); then
    say "  worker updated"
  else
    say "  FAILED to set the Worker secret. All ${#REPOS[@]} repositories already hold"
    say "  the new token; only the Worker is stale. Retry:"
    say "    cd worker && ./node_modules/.bin/wrangler secret put REVIEW_TELEMETRY_TOKEN"
    exit 1
  fi
else
  say "skipping the Worker (--skip-worker)"
fi
say ""

# ------------------------------------------------------------------ verify
say "verify (per repo):"
for r in "${REPOS[@]}"; do
  say "  gh run list --repo $r --workflow claude-code-review.yml --limit 5"
done
say ""
say "A clean workflow exit is not proof: the telemetry step exits 0 even when the"
say "token or URL is missing. The rotation is not proven until a round from each"
say "repository has written a row after $START_TIME:"
say "  cd worker && ./node_modules/.bin/wrangler d1 execute review-telemetry --remote --json --command \\"
say "    \"SELECT repository, COUNT(*) AS n, MAX(recorded_at) AS last FROM usage_records"
say "     WHERE recorded_at > '$START_TIME' GROUP BY repository\""
