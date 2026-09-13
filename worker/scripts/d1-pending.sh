#!/usr/bin/env bash
# Names the files in worker/migrations that d1_migrations on the remote database does not
# list. Exit 0: none. Exit 2: pending, one name per line on stdout. Exit 1: the table could
# not be read, so the state is unknown and nothing should act on it. Reads the table itself
# because `wrangler d1 migrations list` reported a clean state on a credential that could
# not query the database (measured 2026-09-08, #164).
set -euo pipefail
cd "$(dirname "$0")/.."

db="${D1_DATABASE:-review-telemetry}"
err="$(mktemp)"
trap 'rm -f "$err"' EXIT

set +e
rows="$(./node_modules/.bin/wrangler d1 execute "$db" --remote --json \
  --command "SELECT name FROM d1_migrations ORDER BY id" 2>"$err")"
status=$?
set -e

if [ "$status" -ne 0 ]; then
  cat "$err" >&2
  echo "d1_migrations could not be read: wrangler d1 execute exited with status ${status}" >&2
  exit 1
fi
if ! printf '%s' "$rows" | jq -e 'type == "array" and (.[0].results | type == "array")' >/dev/null 2>&1; then
  printf '%s\n' "$rows" >&2
  echo "d1_migrations could not be read: wrangler d1 execute returned no result set" >&2
  exit 1
fi

applied="$(printf '%s' "$rows" | jq -r '.[0].results[].name')"
pending=0
for file in migrations/*.sql; do
  name="$(basename "$file")"
  if ! printf '%s\n' "$applied" | grep -qxF -- "$name"; then
    echo "$name"
    pending=1
  fi
done

if [ "$pending" -eq 1 ]; then
  exit 2
fi
