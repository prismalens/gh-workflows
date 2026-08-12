#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONSUMERS_FILE="${ROOT_DIR}/consumers.json"

if [ ! -f "$CONSUMERS_FILE" ]; then
  echo "Error: consumers.json not found at ${CONSUMERS_FILE}" >&2
  exit 1
fi

DRIFT_FOUND=0

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

while read -r repo workflow; do
  canonical_path="${ROOT_DIR}/canonical/${workflow}"
  if [ ! -f "$canonical_path" ]; then
    echo "ERROR: Canonical file canonical/${workflow} missing" >&2
    DRIFT_FOUND=1
    continue
  fi

  remote_tmp="${TMP_DIR}/remote_${workflow}"

  set +e
  api_response=$(gh api "repos/${repo}/contents/.github/workflows/${workflow}" 2>/dev/null)
  api_status=$?
  set -e

  if [ $api_status -ne 0 ] || [ -z "$api_response" ]; then
    echo "MISSING: ${repo} .github/workflows/${workflow}"
    DRIFT_FOUND=1
    continue
  fi

  content_base64=$(echo "$api_response" | jq -r '.content // empty')
  if [ -z "$content_base64" ]; then
    echo "MISSING: ${repo} .github/workflows/${workflow}"
    DRIFT_FOUND=1
    continue
  fi

  echo "$content_base64" | base64 -d > "$remote_tmp" 2>/dev/null

  set +e
  diff_output=$(diff -u "$canonical_path" "$remote_tmp")
  diff_status=$?
  set -e

  if [ $diff_status -eq 0 ]; then
    echo "IN-SYNC: ${repo} .github/workflows/${workflow}"
  else
    echo "DRIFT: ${repo} .github/workflows/${workflow}"
    echo "$diff_output"
    DRIFT_FOUND=1
  fi
done < <(jq -r '.[] | .repo as $repo | .workflows[] | "\($repo) \(.)"' "$CONSUMERS_FILE")

if [ $DRIFT_FOUND -ne 0 ]; then
  exit 1
fi
