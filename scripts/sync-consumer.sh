#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <owner/repo>" >&2
  exit 1
fi

CONSUMER_REPO="$1"

# Refuse to run if the working copy of gh-workflows is dirty
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working copy is dirty. Please commit or stash changes before running sync." >&2
  exit 1
fi

SHORT_SHA=$(git rev-parse --short HEAD)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONSUMERS_FILE="${ROOT_DIR}/consumers.json"

if [ ! -f "$CONSUMERS_FILE" ]; then
  echo "Error: consumers.json not found at ${CONSUMERS_FILE}" >&2
  exit 1
fi

# Verify consumer repo is in consumers.json and get workflows
WORKFLOWS=$(jq -r --arg repo "$CONSUMER_REPO" '.[] | select(.repo == $repo) | .workflows[]' "$CONSUMERS_FILE")
if [ -z "$WORKFLOWS" ]; then
  echo "Error: Consumer repository '${CONSUMER_REPO}' not configured in consumers.json" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Cloning ${CONSUMER_REPO} into temporary workspace..."
gh repo clone "$CONSUMER_REPO" "${TMP_DIR}/repo" -- --depth 1

cd "${TMP_DIR}/repo"

BRANCH_NAME="sync-review-workflows-${SHORT_SHA}"
git checkout -b "$BRANCH_NAME"

mkdir -p .github/workflows

for wf in $WORKFLOWS; do
  canonical_file="${ROOT_DIR}/canonical/${wf}"
  if [ ! -f "$canonical_file" ]; then
    echo "Error: Canonical file canonical/${wf} does not exist" >&2
    exit 1
  fi
  cp "$canonical_file" ".github/workflows/${wf}"
done

if [ -z "$(git status --porcelain)" ]; then
  echo "No workflow changes detected for ${CONSUMER_REPO}. Target is already up-to-date."
  exit 0
fi

git add .github/workflows/
COMMIT_MSG="ci: sync review workflows from prismalens/gh-workflows@${SHORT_SHA}"
git commit -m "$COMMIT_MSG"

echo "Pushing branch ${BRANCH_NAME} to origin..."
git push origin "$BRANCH_NAME"

echo "Creating pull request..."
gh pr create \
  --repo "$CONSUMER_REPO" \
  --head "$BRANCH_NAME" \
  --title "$COMMIT_MSG" \
  --body "Automated sync of canonical review workflows from prismalens/gh-workflows@${SHORT_SHA}."
