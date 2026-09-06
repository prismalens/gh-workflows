#!/usr/bin/env bash
# Bring one repository to the house baseline: merge settings, labels, branch ruleset.
# Idempotent, so it sets up a new repo and corrects a drifted one with the same command.
# Run on demand. Nothing here is scheduled, because repo-level variation is deliberate.
set -euo pipefail

REPO=""
DRY=0
RULESET_NAME="main protection"
REQUIRED_CHECKS=("CI gate" "Validate PR title (conventional commits)")
LABEL_SOURCE=""   # set with --clone-labels; empty means required labels only

# Labels every repo needs because doctrine references them by name. `coderabbit_review`
# is the manual admission gate in the coderabbit-lane skill; without it the escalation
# path that skill documents cannot be used at all.
REQUIRED_LABELS=(
  "coderabbit_review|5319e7|Admit this PR to the CodeRabbit lane"
)

usage() {
  cat <<'EOF'
Usage: setup-repo.sh --repo OWNER/NAME [--dry-run] [options]

  --repo OWNER/NAME     Repository to configure. Required.
  --dry-run             Print what would change. Touches nothing.
  --clone-labels REPO   Also copy every label from REPO. Off by default, because
                        repo-specific labels should not spread.
  --check NAME          Required status check for the ruleset. Repeatable;
                        replaces the defaults on first use.
  --skip-ruleset        Settings and labels only.
  --no-labels           Skip the label pass.

Sections run in order: settings, labels, ruleset, then a read-only report of
missing workflow caller stubs.
EOF
}

CHECKS_OVERRIDDEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --clone-labels) LABEL_SOURCE="${2:-}"; shift 2 ;;
    --check)
      [ "$CHECKS_OVERRIDDEN" -eq 0 ] && { REQUIRED_CHECKS=(); CHECKS_OVERRIDDEN=1; }
      REQUIRED_CHECKS+=("${2:-}"); shift 2 ;;
    --skip-ruleset) SKIP_RULESET=1; shift ;;
    --no-labels) NO_LABELS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
SKIP_RULESET="${SKIP_RULESET:-0}"
NO_LABELS="${NO_LABELS:-0}"

[ -n "$REPO" ] || { echo "--repo is required" >&2; usage >&2; exit 2; }
command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
gh api "repos/$REPO" --jq .full_name >/dev/null || { echo "cannot read $REPO" >&2; exit 1; }

say() { printf '%s\n' "$*"; }
act() {  # act "<description>" <command...>
  local desc="$1"; shift
  if [ "$DRY" -eq 1 ]; then say "  WOULD $desc"; else say "  $desc"; "$@"; fi
}

[ "$DRY" -eq 1 ] && say "DRY RUN, nothing will be changed." && say ""
say "repo: $REPO"
say ""

# ---------------------------------------------------------------- settings
say "settings"
CURRENT=$(gh api "repos/$REPO" --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}')
# Only settings the ruleset depends on. Squash-only is what required_linear_history
# needs to hold. Wiki, projects and discussions are taste and stay per-repo.
declare -A WANT=(
  [allow_squash_merge]=true
  [allow_merge_commit]=false
  [allow_rebase_merge]=false
  [delete_branch_on_merge]=true
)
PATCH_ARGS=()
for k in "${!WANT[@]}"; do
  have=$(printf '%s' "$CURRENT" | jq -r --arg k "$k" '.[$k]')
  if [ "$have" != "${WANT[$k]}" ]; then
    say "  $k: $have -> ${WANT[$k]}"
    PATCH_ARGS+=(-F "$k=${WANT[$k]}")
  fi
done
if [ ${#PATCH_ARGS[@]} -eq 0 ]; then
  say "  already at baseline"
elif [ "$DRY" -eq 1 ]; then
  say "  WOULD PATCH repos/$REPO"
else
  gh api -X PATCH "repos/$REPO" "${PATCH_ARGS[@]}" --silent
  say "  patched"
fi
say ""

# ------------------------------------------------------------------ labels
if [ "$NO_LABELS" -eq 0 ]; then
  say "labels"
  # `gh label clone` skips labels that already exist, so it never overwrites a colour
  # or description someone set on purpose. --force would; deliberately not used.
  # Cloning a whole label set spreads repo-specific labels (certification-gate,
  # prismalens-r3-gate) into repos that have no use for them, so it is opt-in.
  if [ -z "$LABEL_SOURCE" ]; then
    :
  elif [ "$REPO" = "$LABEL_SOURCE" ]; then
    say "  clone source is the target, skipping"
  else
    act "clone labels from $LABEL_SOURCE" \
      gh label clone "$LABEL_SOURCE" --repo "$REPO"
  fi
  for spec in "${REQUIRED_LABELS[@]}"; do
    IFS='|' read -r name color desc <<<"$spec"
    if gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name' | grep -qxF "$name"; then
      say "  $name present"
    else
      act "create label $name" \
        gh label create "$name" --repo "$REPO" --color "$color" --description "$desc"
    fi
  done
  say ""
fi

# ----------------------------------------------------------------- ruleset
if [ "$SKIP_RULESET" -eq 0 ]; then
  say "ruleset"
  # "No rulesets" and "not allowed to look" are different answers and must not share a
  # branch: a private repo on a free plan answers 403 "Upgrade to GitHub Pro", and
  # folding that into an empty list reports an unprotected repo as merely bare.
  RS_ERR=$(mktemp); trap 'rm -f "$RS_ERR"' EXIT
  if ! RULESETS=$(gh api "repos/$REPO/rulesets" 2>"$RS_ERR"); then
    if grep -q 'Upgrade to GitHub Pro' "$RS_ERR"; then
      say "  UNAVAILABLE: private repo on a free plan; rulesets cannot exist here"
    elif grep -qE '\b(403|404)\b|Not Found|Must have admin' "$RS_ERR"; then
      say "  UNKNOWN: cannot read rulesets (no admin rights on this repo)"
      say "  this is not evidence the repo is unprotected"
    else
      say "  UNKNOWN: rulesets query failed: $(head -1 "$RS_ERR")"
    fi
  else
    EXISTING=$(printf '%s' "$RULESETS" | jq -r --arg n "$RULESET_NAME" '.[]|select(.source_type=="Repository" and .name==$n)|.id' | head -1)
    CHECKS_JSON=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R '{context:.}' | jq -s '.')
    BODY=$(jq -n --arg name "$RULESET_NAME" --argjson checks "$CHECKS_JSON" '{
      name: $name, target: "branch", enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        {type:"deletion"}, {type:"non_fast_forward"},
        {type:"pull_request", parameters:{
          required_approving_review_count:0, dismiss_stale_reviews_on_push:false,
          require_code_owner_review:false, require_last_push_approval:false,
          required_review_thread_resolution:true, allowed_merge_methods:["squash"],
          require_extra_approval_for_unattributed_changes:true}},
        {type:"required_status_checks", parameters:{
          strict_required_status_checks_policy:true, required_status_checks:$checks}},
        {type:"merge_queue", parameters:{
          check_response_timeout_minutes:60, grouping_strategy:"ALLGREEN",
          max_entries_to_build:5, max_entries_to_merge:5,
          merge_method:"SQUASH", min_entries_to_merge:1,
          min_entries_to_merge_wait_minutes:1}},
        {type:"required_linear_history"}
      ]}')
    POST_FAILED=0
    if [ -n "$EXISTING" ]; then
      # Never PUT over a live ruleset. PUT replaces wholesale, and this body is a
      # template: any rule the live one has and the template lacks would be silently
      # switched off. sreforge carries required_review_thread_resolution and
      # require_extra_approval_for_unattributed_changes, and on a contract with zero
      # required approvals thread resolution is the only thing enforcing a finding.
      say "  \"$RULESET_NAME\" exists (id $EXISTING). Not touching it."
      LIVE=$(printf '%s' "$RULESETS" | jq --arg n "$RULESET_NAME" '.[]|select(.source_type=="Repository" and .name==$n)')
      LIVE_FULL=$(gh api "repos/$REPO/rulesets/$EXISTING" 2>/dev/null || printf '%s' "$LIVE")
      LIVE_TYPES=$(printf '%s' "$LIVE_FULL" | jq -r '[.rules[]?.type]|sort|join(",")')
      WANT_TYPES=$(printf '%s' "$BODY" | jq -r '[.rules[]?.type]|sort|join(",")')
      say "  live rules:  $LIVE_TYPES"
      say "  template:    $WANT_TYPES"
      [ "$LIVE_TYPES" = "$WANT_TYPES" ] && say "  rule types match" || say "  RULE TYPES DIFFER, review by hand"
      PARAM_REPORT=$(jq -n --argjson live "${LIVE_FULL:-{\}}" --argjson want "$BODY" '
        def normalize:
          if type == "object" then
            to_entries
            | sort_by(.key)
            | map({key: .key, value: (.value | normalize)})
            | from_entries
          elif type == "array" then
            map(normalize)
            | if length == 0 then
                .
              elif all(type == "object") then
                sort_by([(.context // .id // .name // null), tojson])
              elif all(type == "number" or type == "string" or type == "boolean") then
                sort
              else
                sort_by(tojson)
              end
          else
            .
          end;

        ($live.rules // []) as $lr
        | ($want.rules // []) as $wr
        | (([$lr[]?.type] + [$wr[]?.type]) | unique | sort) as $types
        | [
            $types[] as $t
            | (first($lr[]? | select(.type == $t) | .parameters) // {}) as $lp
            | (first($wr[]? | select(.type == $t) | .parameters) // {}) as $wp
            | ($wp | keys) as $wkeys
            | $wkeys[] as $k
            | ($lp[$k] | normalize) as $lv
            | ($wp[$k] | normalize) as $wv
            | select($lv != $wv)
            | "PARAM DIFFERS \($t).\($k): live=\($lv) template=\($wv)"
          ] as $diffs
        | [
            $types[] as $t
            | (first($lr[]? | select(.type == $t) | .parameters) // {}) as $lp
            | (first($wr[]? | select(.type == $t) | .parameters) // {}) as $wp
            | (($lp | keys) - ($wp | keys))[]
          ] as $ignored
        | { diffs: $diffs, has_ignored: ($ignored | length > 0) }
      ')
      DIFF_COUNT=$(printf '%s' "$PARAM_REPORT" | jq '.diffs | length')
      if [ "$DIFF_COUNT" -eq 0 ]; then
        say "  parameters match"
      else
        while IFS= read -r line; do
          if [ -n "$line" ]; then
            say "  $line"
          fi
        done < <(printf '%s' "$PARAM_REPORT" | jq -r '.diffs[]')
      fi
      if [ "$(printf '%s' "$PARAM_REPORT" | jq -r .has_ignored)" = "true" ]; then
        say "  keys absent from template not compared"
      fi
      LIVE_CHECKS=$(printf '%s' "$LIVE_FULL" | jq -r '[.rules[]?|select(.type=="required_status_checks")|.parameters.required_status_checks[]?.context]|sort|join(", ")')
      say "  live checks: ${LIVE_CHECKS:-none}"
      # Joined the same way the live line is, so the two are comparable by eye.
      want_checks=$(printf '%s, ' "${REQUIRED_CHECKS[@]}"); want_checks=${want_checks%, }
      say "  want checks: $want_checks"
      say "  to change it, edit the ruleset in the GitHub UI or PATCH the one field."
    elif [ "$DRY" -eq 1 ]; then
      say "  WOULD create \"$RULESET_NAME\" on the default branch"
    else
      say "  create \"$RULESET_NAME\" on the default branch"
      if ! gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null 2>"$RS_ERR" <<<"$BODY"; then
        POST_FAILED=1
        if grep -q 'Upgrade to GitHub Pro' "$RS_ERR"; then
          say "  UNAVAILABLE: private repo on a free plan; rulesets cannot exist here"
        elif grep -qE '\b(403|404)\b|Not Found|Must have admin' "$RS_ERR"; then
          say "  UNKNOWN: cannot create ruleset (no admin rights on this repo)"
          say "  this is not evidence the repo is unprotected"
        else
          say "  UNKNOWN: ruleset creation failed: $(head -1 "$RS_ERR")"
        fi
      fi
    fi
    if [ "$POST_FAILED" -eq 0 ]; then
      say "  note: an org-level ruleset, if one exists, applies on top of this and cannot be relaxed here"
    fi
  fi
  say ""
fi

# ------------------------------------------------- caller stubs, report only
# Writing these means a PR against the target repo, which is that repo's business.
say "workflow caller stubs (report only)"
for f in claude-code-review.yml claude.yml pr-title.yml dependabot-auto-merge.yml; do
  if gh api "repos/$REPO/contents/.github/workflows/$f" --jq .name >/dev/null 2>&1; then
    say "  present  $f"
  else
    say "  MISSING  $f"
  fi
done
if gh api "repos/$REPO/contents/.github/dependabot.yml" --jq .name >/dev/null 2>&1; then
  say "  present  .github/dependabot.yml"
else
  say "  MISSING  .github/dependabot.yml"
fi
say ""
say "done."
