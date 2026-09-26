#!/usr/bin/env bash
# `gh` as the engine sees it. The lane's prompt posts its summary with `gh pr comment`, and
# that command is on the allowlist, so a runner that executed it would post to the PR. This
# shim records `pr comment` to the tool log and answers as gh would; every other invocation
# goes to the real gh at $ASSAYER_REAL_GH. `pr review` and `pr merge` are refused outright:
# the policy never allows them, and a shim that forwarded them would widen the lane.
set -u
log="${ASSAYER_TOOL_LOG:?ASSAYER_TOOL_LOG unset}"
real="${ASSAYER_REAL_GH:?ASSAYER_REAL_GH unset}"
sub="${1:-} ${2:-}"
case "$sub" in
  "pr review"|"pr merge"|"pr close"|"pr edit"|"pr ready"|"api "*|"repo delete"*)
    echo "gh shim: '$sub' is not allowed in a review round" >&2; exit 1 ;;
  "pr comment")
    shift 2
    body=""; bodyfile=""; args=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --body|-b) body="${2:-}"; shift 2 ;;
        --body=*) body="${1#--body=}"; shift ;;
        --body-file|-F) bodyfile="${2:-}"; shift 2 ;;
        --body-file=*) bodyfile="${1#--body-file=}"; shift ;;
        *) args+=("$1"); shift ;;
      esac
    done
    # A body file is read only from stdin. A path would let a steered engine record any
    # readable file (a token store, /proc/self/environ) as the summary the poster publishes.
    if [ -n "$bodyfile" ]; then
      if [ "$bodyfile" = "-" ]; then body="$(cat)"; else echo "gh shim: --body-file takes only '-' (stdin) in a review round; pass --body or pipe the text" >&2; exit 1; fi
    fi
    if [ -z "$body" ]; then echo "gh shim: pr comment needs --body or --body-file" >&2; exit 1; fi
    # Redact before the record, not after: the mapper filters when it reads this log back, by
    # which time the body is already on disk. The shapes come from secret-check.js so this
    # shell path and acp-map.js can never drift. Anything but a clean pass redacts.
    # The runner copies this shim to <out>/bin/gh, so its own directory holds no module.
    # ASSAYER_SECRET_CHECK carries the real path; the sibling is the fallback for a shim run
    # in place. A checker that cannot run is an environment fault, not a credential: it still
    # redacts, but it says so, and it never claims the body looked like a secret.
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    checker="${ASSAYER_SECRET_CHECK:-$here/secret-check.js}"
    red=""
    printf '%s' "$body" | "${ASSAYER_NODE:-node}" "$checker"; rc=$?
    case "$rc" in
      0) ;;
      10) red="credential-shaped body"; body="" ;;
      *) echo "gh shim: secret-check could not run (exit $rc, $checker); recording the body as redacted" >&2
         red="secret-check unavailable"; body="" ;;
    esac
    ASSAYER_REDACTED="$red" python3 - "$log" "$body" "${args[@]+"${args[@]}"}" <<'PY'
import json, os, sys, datetime
log, body, *args = sys.argv[1:]
red = os.environ.get('ASSAYER_REDACTED') or None
entry = {'at': datetime.datetime.utcnow().isoformat() + 'Z', 'server': 'gh-shim', 'tool': 'gh_pr_comment',
         'input': {'body': None if red else body, 'args': args}}
if red:
    entry['redacted'] = red
with open(log, 'a') as f:
    f.write(json.dumps(entry) + '\n')
PY
    echo "https://github.com/recorded/by/assayer-runner/pull/0#issuecomment-recorded"; exit 0 ;;
esac
# In the container only the proxy reaches GitHub; the engine itself never gets HTTPS_PROXY (#184).
if [ -n "${ASSAYER_HTTPS_PROXY:-}" ]; then export HTTPS_PROXY="$ASSAYER_HTTPS_PROXY" https_proxy="$ASSAYER_HTTPS_PROXY"; fi
exec "$real" "$@"
