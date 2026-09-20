# Review prompt template

`template.md` is a byte-for-byte copy of the heredoc body written by the "Build the
review prompt" step (`id: build-prompt`) in
`.github/workflows/claude-code-review.yml`, between `cat > "$template" <<'PROMPT_TEMPLATE_EOF'`
and the closing `PROMPT_TEMPLATE_EOF`. The YAML block scalar's own indentation (10
spaces, from `run: |`) is stripped; nothing else is. It still contains every
`@@TOKEN@@` placeholder, because `prompt_hash` in that step is `sha256sum` over this
file, never over the substituted text (#47) — that is what keeps `prompt_hash` stable
across every repo, PR, and round type. `sha256sum runner/prompt/template.md` must equal
`prompt_hash` on any run of that step; verified against a real run
(prismalens/sreforge run 34747325802, gh-workflows@ed12799) and against
`tests/test-prompt-hash-template.py` in this repo, which extracts and runs the same
step directly from the workflow YAML.

## Re-sync

Whenever the "Build the review prompt" step's heredoc body changes, copy it here again
verbatim (same strip: only the 10-space YAML indent) and re-run
`node --test runner/test/prompt.test.js`. If the workflow's `STEP4_AGENT_PLAN_LINES` or
`step5_validation` Python literals change, update the matching constants in
`../src/prompt.js` by hand — they are not derived from `template.md`, they are copied
from the `BUILD_PROMPT_PY` heredoc in the same step.

## Tokens

| Token | Meaning | Source |
|---|---|---|
| `REPO` | owner/repo of the PR | env `REPO` (`github.repository`) |
| `PR_NUMBER` | PR number | env `PR_NUMBER` (`needs.resolve.outputs.number`) |
| `STEP3_TASK` | step 3 instruction, incremental vs. full | env `STEP3_TASK` |
| `STEP4_AGENT_PLAN` | full step-4 agent plan (4 or 6 agents) | computed in Python from `LEVEL` |
| `STEP5_VALIDATION` | step-5 validation instructions | computed in Python, fixed text |
| `STEP9_HEADER` | first line of the summary comment | env `STEP9_HEADER` |
| `DEDUP_DISABLED_BLOCK` | dedup-off paragraph, `review-full` only | env `DEDUP_DISABLED_BLOCK` |
| `INCREMENTAL_ROUND_BLOCK` | range paragraph, `incremental` only | env `INCREMENTAL_ROUND_BLOCK` |
| `AGENT3_FOCUS` | Agent 3's scope | env `AGENT3_FOCUS` (nested inside `STEP4_AGENT_PLAN`) |
| `AGENT4_FOCUS` | Agent 4's scope | env `AGENT4_FOCUS` (nested) |
| `STEP4_CONTEXT_SUFFIX` | extra context for subagents | env `STEP4_CONTEXT_SUFFIX` (nested) |
| `AGENTS1_2_PATH_INSTRUCTIONS` | path-instructions note for Agents 1+2 | env, set when `path_instructions` matched (nested) |
| `AGENT3_PATH_INSTRUCTIONS` | path-instructions note for Agent 3 | env, same trigger (nested) |
| `AGENT4_PATH_INSTRUCTIONS` | path-instructions note for Agent 4 | env, same trigger (nested) |

The last 6 rows never appear in `template.md` directly — they appear inside the text
`STEP4_AGENT_PLAN` computes, and are resolved by the same flat substitution pass once
that text is spliced in. `../src/prompt.js`'s `TOKENS` export carries this table too.
