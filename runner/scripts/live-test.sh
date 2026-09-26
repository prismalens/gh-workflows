#!/usr/bin/env bash
# The operator's acceptance for a box (#184): build the image, pass the container check, run one
# real round, and prove no configured key reached the round directory. Run once per box and after
# every image rebuild. Usage: GH_READ_TOKEN=... scripts/live-test.sh <config.json> <owner/repo> <pr>
set -euo pipefail
cd "$(dirname "$0")/.."
config="$1"; repo="$2"; pr="$3"
: "${GH_READ_TOKEN:?GH_READ_TOKEN must be a read-only token for $repo}"

node scripts/build-image.mjs
node src/daemon.js --config "$config" --check
out="$(node scripts/live-round.mjs --config "$config" --repo "$repo" --pr "$pr" | tee /dev/stderr)"
round="$(printf '%s\n' "$out" | sed -n 's/^round //p')"
[ -n "$round" ] && [ -d "$round" ] || { echo "live-test: no round directory" >&2; exit 1; }
[ -f "$round/staged.json" ] || { echo "live-test: staging wrote no staged.json" >&2; exit 1; }
[ -f "$round/summary.json" ] || { echo "live-test: the engine wrote no summary.json" >&2; exit 1; }

for var in $(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const x of c.credentials)if(x.env)console.log(x.env)' "$config"); do
  value="${!var:-}"
  if [ -n "$value" ] && grep -rqF -- "$value" "$round"; then
    echo "live-test: the key in \$$var reached $round" >&2; exit 1
  fi
done
echo "live-test: conclusion $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).conclusion)' "$round/summary.json"), round kept at $round"
