// Reproduces the substitution done by the BUILD_PROMPT_PY heredoc inside the
// "Build the review prompt" step (id: build-prompt) of
// .github/workflows/claude-code-review.yml. Keep this file and runner/prompt/template.md
// in sync with that step by hand; see runner/prompt/README.md for the re-sync procedure.
//
// The Python does two kinds of substitution into the template written by the shell
// heredoc (PROMPT_TEMPLATE_EOF):
//   1. Two tokens, @@STEP4_AGENT_PLAN@@ and @@STEP5_VALIDATION@@, are filled from
//      multi-paragraph text computed in Python (never from a GH Actions env var
//      directly, because a GH Actions expression string literal cannot carry embedded
//      newlines). @@STEP4_AGENT_PLAN@@ itself varies by review.level and its text
//      carries further @@TOKEN@@ placeholders (@@AGENT3_FOCUS@@ and friends) that are
//      resolved by step 2 below.
//   2. A flat list of tokens (REPO, PR_NUMBER, ...) are replaced from env vars via
//      `text.replace(f'@@{token}@@', os.environ.get(token, ''))` -- Python str.replace
//      replaces every occurrence, same as the split/join used here.
// The two steps run in that order: STEP4_AGENT_PLAN/STEP5_VALIDATION first, then the
// flat env-var tokens, because the flat tokens also appear nested inside the agent-plan
// text once it has been spliced in.

import { createHash } from 'node:crypto';

// Verbatim copy of STEP4_AGENT_PLAN_LINES from the BUILD_PROMPT_PY heredoc.
// review.level (#101): only changes agent count and validation shape, never which code
// is read. 'low' is schema-rejected this release, so in practice LEVEL is 'medium' or
// 'high'; anything else falls back to 'medium', matching Python's '.get(level, ...)'.
const STEP4_AGENT_PLAN_LINES = {
  medium: [
    "Launch 4 agents in parallel to independently review the changes. Each agent should return the list of issues, where each issue includes a description, the reason it was flagged (e.g. \"CLAUDE.md/AGENTS.md adherence\", \"bug\"), and candidate classification (Category, Severity, Effort). The agents review the diff and must not execute the project's tests, type checker, linter, formatter, or package manager (the review job installs no toolchain). The agents should do the following:",
    "",
    "   Agents 1 + 2: CLAUDE.md and AGENTS.md compliance sonnet agents",
    "   Audit changes for CLAUDE.md and AGENTS.md compliance in parallel. Note: When evaluating compliance for a file, you should only consider CLAUDE.md and AGENTS.md files that share a file path with the file or parents.@@AGENTS1_2_PATH_INSTRUCTIONS@@",
    "",
    "   Agent 3: Opus bug agent (parallel subagent with agent 4)",
    "   Scan for obvious bugs. @@AGENT3_FOCUS@@ Flag only significant bugs; ignore nitpicks and likely false positives. Do not flag issues that you cannot validate without looking at context outside of the git diff.@@AGENT3_PATH_INSTRUCTIONS@@",
    "",
    "   Agent 4: Opus bug agent (parallel subagent with agent 3)",
    "   Look for problems that exist in the introduced code. This could be security issues, incorrect logic, etc. @@AGENT4_FOCUS@@@@AGENT4_PATH_INSTRUCTIONS@@",
    "",
    "   **CRITICAL: We only want HIGH SIGNAL issues.** Flag issues where:",
    "   - The code will fail to compile or parse (syntax errors, type errors, missing imports, unresolved references)",
    "   - The code will definitely produce wrong results regardless of inputs (clear logic errors)",
    "   - Clear, unambiguous CLAUDE.md or AGENTS.md violations where you can quote the exact rule being broken",
    "",
    "   Do NOT flag:",
    "   - Code style or quality concerns",
    "   - Potential issues that depend on specific inputs or state",
    "   - Subjective suggestions or improvements",
    "",
    "   If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time.",
    "",
    "   Before writing a finding of the form \"X says A, and this contradicts B\", Grep the phrase you are quoting across every file this diff changes. The changed files are already in the working directory, so this costs no fetch. Say which files the phrase turned up in. Search inside the diff only, never the wider repository. Do this for distinctive multi-word phrasing. Do not do it for a common identifier that appears in many files, because a rule that searches everything produces a round that reads instead of reviewing. If the phrase appears in a second changed file, that is a different and usually worse defect than one file carrying it. Report it as its own finding. Never fold the second occurrence into the first.",
    "",
    "   In addition to the above, each subagent should be told the PR title and description@@STEP4_CONTEXT_SUFFIX@@. This will help provide context regarding the author's intent."
  ],
  high: [
    "Launch 6 agents in parallel to independently review the changes. Each agent should return the list of issues, where each issue includes a description, the reason it was flagged (e.g. \"CLAUDE.md/AGENTS.md adherence\", \"bug\"), and candidate classification (Category, Severity, Effort). The agents review the diff and must not execute the project's tests, type checker, linter, formatter, or package manager (the review job installs no toolchain). The agents should do the following:",
    "",
    "   Agents 1 + 2: CLAUDE.md and AGENTS.md compliance sonnet agents",
    "   Audit changes for CLAUDE.md and AGENTS.md compliance in parallel. Note: When evaluating compliance for a file, you should only consider CLAUDE.md and AGENTS.md files that share a file path with the file or parents.@@AGENTS1_2_PATH_INSTRUCTIONS@@",
    "",
    "   Agent 3: Opus bug agent (parallel subagent with agents 4, 5, and 6)",
    "   Scan for obvious bugs. @@AGENT3_FOCUS@@ Flag only significant bugs; ignore nitpicks and likely false positives. Do not flag issues that you cannot validate without looking at context outside of the git diff.@@AGENT3_PATH_INSTRUCTIONS@@",
    "",
    "   Agent 4: Opus bug agent (parallel subagent with agents 3, 5, and 6)",
    "   Look for problems that exist in the introduced code. This could be security issues, incorrect logic, etc. @@AGENT4_FOCUS@@@@AGENT4_PATH_INSTRUCTIONS@@",
    "",
    "   Agent 5: Opus bug agent (parallel subagent with agents 3, 4, and 6)",
    "   Examine how the diff's changed code interacts with unchanged code it calls into or that calls it: altered function signatures, changed return shapes or error paths, and call sites now feeding old code values it was not written to expect. Flag only significant bugs; ignore nitpicks and likely false positives. Do not flag issues that you cannot validate without looking at context outside of the git diff.",
    "",
    "   Agent 6: Opus bug agent (parallel subagent with agents 3, 4, and 5)",
    "   Examine the contracts and schemas the diff touches: API request/response shapes, database schemas and migrations, serialization formats, and public function signatures. Flag a break in what a caller or consumer already relies on. Flag only significant bugs; ignore nitpicks and likely false positives. Do not flag issues that you cannot validate without looking at context outside of the git diff.",
    "",
    "   **CRITICAL: We only want HIGH SIGNAL issues.** Flag issues where:",
    "   - The code will fail to compile or parse (syntax errors, type errors, missing imports, unresolved references)",
    "   - The code will definitely produce wrong results regardless of inputs (clear logic errors)",
    "   - Clear, unambiguous CLAUDE.md or AGENTS.md violations where you can quote the exact rule being broken",
    "",
    "   Do NOT flag:",
    "   - Code style or quality concerns",
    "   - Potential issues that depend on specific inputs or state",
    "   - Subjective suggestions or improvements",
    "",
    "   If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time.",
    "",
    "   Before writing a finding of the form \"X says A, and this contradicts B\", Grep the phrase you are quoting across every file this diff changes. The changed files are already in the working directory, so this costs no fetch. Say which files the phrase turned up in. Search inside the diff only, never the wider repository. Do this for distinctive multi-word phrasing. Do not do it for a common identifier that appears in many files, because a rule that searches everything produces a round that reads instead of reviewing. If the phrase appears in a second changed file, that is a different and usually worse defect than one file carrying it. Report it as its own finding. Never fold the second occurrence into the first.",
    "",
    "   In addition to the above, each subagent should be told the PR title and description@@STEP4_CONTEXT_SUFFIX@@. This will help provide context regarding the author's intent."
  ],
};

// Verbatim copy of step5_validation from the BUILD_PROMPT_PY heredoc. Unlike
// STEP4_AGENT_PLAN, this text does not vary by level.
const STEP5_VALIDATION = "For each issue found in step 4, launch parallel subagents to validate the issue. These subagents should get the PR title and description along with a description of the issue. The agent's job is to review the issue to validate that the stated issue is truly an issue with high confidence, and formulate the verification evidence (1-3 sentences under 60 words stating what was inspected and what was proven). For example, if an issue such as \"variable is not defined\" was flagged, the subagent's job would be to validate that is actually true in the code. For CLAUDE.md and AGENTS.md issues, the agent should validate that the rule that was violated is scoped for this file and is actually violated. Use Opus subagents for bugs and logic issues, and sonnet agents for CLAUDE.md and AGENTS.md violations.";

// Flat tokens the Python replaces directly from env vars, in the order the
// `for token in [...]` loop in BUILD_PROMPT_PY lists them.
const FLAT_TOKENS = [
  'REPO',
  'PR_NUMBER',
  'STEP3_TASK',
  'AGENT3_FOCUS',
  'AGENT4_FOCUS',
  'STEP4_CONTEXT_SUFFIX',
  'STEP9_HEADER',
  'DEDUP_DISABLED_BLOCK',
  'INCREMENTAL_ROUND_BLOCK',
  'AGENTS1_2_PATH_INSTRUCTIONS',
  'AGENT3_PATH_INSTRUCTIONS',
  'AGENT4_PATH_INSTRUCTIONS',
];

// Every @@NAME@@ placeholder that appears literally in runner/prompt/template.md, with a
// one-line meaning and the env var (or, for the two Python-computed blocks, the level
// input) the workflow's `build-prompt` step fills it from.
export const TOKENS = [
  { name: 'REPO', meaning: 'owner/repo of the pull request being reviewed', env: 'REPO (github.repository)' },
  { name: 'PR_NUMBER', meaning: 'the pull request number', env: 'PR_NUMBER (needs.resolve.outputs.number)' },
  { name: 'STEP3_TASK', meaning: 'step 3 instruction text; differs for an incremental round (reads .claude-incremental-range.json) vs. a full round', env: 'STEP3_TASK, derived from steps.mode.outputs.mode/range_base/range_head' },
  { name: 'STEP4_AGENT_PLAN', meaning: 'the whole multi-agent plan for step 4 (4 agents for medium, 6 for high)', env: "not an env var directly -- computed in Python from LEVEL (steps.model.outputs.level)" },
  { name: 'STEP5_VALIDATION', meaning: 'step 5 validation-subagent instructions; fixed text, does not vary by level', env: 'not an env var -- a constant computed in Python' },
  { name: 'STEP9_HEADER', meaning: 'first line of the mandatory summary PR comment; names the round type (review / review-full / incremental with range)', env: 'STEP9_HEADER, derived from steps.mode.outputs.mode/range_base_short/range_head_short' },
  { name: 'DEDUP_DISABLED_BLOCK', meaning: 'extra paragraph telling the model dedup is off, only present for a review-full round', env: "DEDUP_DISABLED_BLOCK, set when steps.mode.outputs.mode == 'review-full'" },
  { name: 'INCREMENTAL_ROUND_BLOCK', meaning: 'extra paragraph describing the commit range and dedup-against-unresolved-threads-only rule, only present for an incremental round', env: "INCREMENTAL_ROUND_BLOCK, set when steps.mode.outputs.mode == 'incremental'" },
];

// @@NAME@@ placeholders that never appear in template.md itself -- they appear only
// inside the STEP4_AGENT_PLAN_LINES text above, and are resolved by the same
// flat-token pass once @@STEP4_AGENT_PLAN@@ has been spliced into the template. Kept
// separate from TOKENS because "the template contains every TOKENS entry" (see
// runner/test/prompt.test.js) is true of TOKENS and false of these.
export const NESTED_TOKENS = [
  { name: 'AGENT3_FOCUS', meaning: 'what Agent 3 (Opus bug agent) should scope its scan to -- the range for incremental, the diff otherwise', env: 'AGENT3_FOCUS, derived from steps.mode.outputs.mode' },
  { name: 'AGENT4_FOCUS', meaning: 'what Agent 4 (Opus bug agent) should scope its scan to', env: 'AGENT4_FOCUS, derived from steps.mode.outputs.mode' },
  { name: 'STEP4_CONTEXT_SUFFIX', meaning: "extra context appended to 'each subagent should be told the PR title and description' -- names the commit range and the range JSON path for incremental", env: 'STEP4_CONTEXT_SUFFIX, derived from steps.mode.outputs.mode/range_base/range_head' },
  { name: 'AGENTS1_2_PATH_INSTRUCTIONS', meaning: 'sentence telling Agents 1+2 to also read .claude-path-instructions.md as CLAUDE.md/AGENTS.md-equivalent rules, only when a path instruction matched', env: "AGENTS1_2_PATH_INSTRUCTIONS, set when steps.path_instructions.outputs.matched == 'true'" },
  { name: 'AGENT3_PATH_INSTRUCTIONS', meaning: 'sentence telling Agent 3 to also read .claude-path-instructions.md as context, only when a path instruction matched', env: "AGENT3_PATH_INSTRUCTIONS, set when steps.path_instructions.outputs.matched == 'true'" },
  { name: 'AGENT4_PATH_INSTRUCTIONS', meaning: 'sentence telling Agent 4 to also read .claude-path-instructions.md as context, only when a path instruction matched', env: "AGENT4_PATH_INSTRUCTIONS, set when steps.path_instructions.outputs.matched == 'true'" },
];

function step4AgentPlan(level) {
  const lines = STEP4_AGENT_PLAN_LINES[level] ?? STEP4_AGENT_PLAN_LINES.medium;
  return lines.join('\n');
}

function replaceAll(text, token, value) {
  return text.split('@@' + token + '@@').join(value ?? '');
}

/**
 * Reproduce the BUILD_PROMPT_PY substitution over the raw template text.
 * @param {string} template - contents of runner/prompt/template.md (or the file the
 *   workflow's heredoc writes), with @@TOKEN@@ placeholders still in place.
 * @param {Object} tokens - values keyed by the flat token names in FLAT_TOKENS, plus
 *   LEVEL ('medium' or 'high', default 'medium') to pick the step 4 agent plan.
 * @returns {string} the fully rendered prompt, matching what
 *   claude-code-review.yml's build-prompt step writes to $GITHUB_OUTPUT as `prompt`.
 */
export function renderPrompt(template, tokens = {}) {
  let text = template;
  text = replaceAll(text, 'STEP4_AGENT_PLAN', step4AgentPlan(tokens.LEVEL ?? 'medium'));
  text = replaceAll(text, 'STEP5_VALIDATION', STEP5_VALIDATION);
  for (const token of FLAT_TOKENS) {
    text = replaceAll(text, token, tokens[token]);
  }
  return text;
}

/**
 * sha256 hex digest over the template text, matching
 * `sha256sum "$template" | cut -d' ' -f1` in the workflow's build-prompt step. This is
 * computed over the TEMPLATE (placeholders still in place), never the rendered prompt.
 * @param {string} template
 * @returns {string} lowercase hex sha256
 */
export function promptHash(template) {
  return createHash('sha256').update(template, 'utf8').digest('hex');
}

// The round-type tokens the workflow's build-prompt env block sets (claude-code-review.yml),
// verbatim. scripts/render-prompt.mjs and the daemon both render through this. Re-sync with it.
export function laneTokens({ repo, pr, level = 'medium', mode = 'review', rangeBase = null, rangeHead = null, pathInstructions = false }) {
  const inc = mode === 'incremental'; const full = mode === 'review-full'; const pi = pathInstructions;
  const rb = rangeBase; const rh = rangeHead;
  const short = (x) => String(x).slice(0, 7);
  return {
    REPO: repo, PR_NUMBER: String(pr), LEVEL: level,
    STEP3_TASK: inc
      ? `Launch a sonnet agent to return a summary of the changes covering the range ${rb}..${rh}, whose changed files and patches are in \`.claude-incremental-range.json\` in the repository root. The agent should read that file rather than treat the whole PR diff as its subject`
      : 'Launch a sonnet agent to view the pull request and return a summary of the changes',
    AGENT3_FOCUS: inc ? 'Focus on the range, with the rest of the PR diff available as context for understanding it but not as a source of findings.' : 'Focus only on the diff itself without reading extra context.',
    AGENT4_FOCUS: inc ? 'Only look for issues that fall within the range.' : 'Only look for issues that fall within the changed code.',
    STEP4_CONTEXT_SUFFIX: inc ? `, the commit range ${rb}..${rh}, and the path \`.claude-incremental-range.json\`` : '',
    STEP9_HEADER: full ? '## Code review — full review' : inc ? `## Code review — incremental (${short(rb)}..${short(rh)})` : '## Code review',
    DEDUP_DISABLED_BLOCK: full ? 'DEDUP IS DISABLED FOR THIS RUN, because an org member explicitly asked for a review from scratch. Existing review comments and threads on this PR are NOT dedup targets. If a finding is real, post it — even when an earlier round already raised the same point. Suppressing findings as "already covered" is exactly the failure this run exists to avoid: it makes the run publish nothing while appearing to succeed.' : '',
    INCREMENTAL_ROUND_BLOCK: inc ? `THIS IS AN INCREMENTAL ROUND covering commits ${rb}..${rh} only. The changed files and patches for that range are in \`.claude-incremental-range.json\` in the repository root. Read it first. Review the range. The rest of the PR diff is legitimate context for understanding it, but findings must be about code inside the range. Only unresolved review threads are dedup targets. A resolved thread must never suppress a finding: a push that reintroduces a bug a human already fixed and resolved would otherwise be waved through as "already covered".` : '',
    AGENTS1_2_PATH_INSTRUCTIONS: pi ? ' Also read `.claude-path-instructions.md` in the repository root. Treat each entry as a rule to audit beside CLAUDE.md and AGENTS.md, flagging with reason "path instruction" and quoting the entry\'s `path`.' : '',
    AGENT3_PATH_INSTRUCTIONS: pi ? ' Also read `.claude-path-instructions.md` in the repository root; treat entries as context for what breaks under those paths.' : '',
    AGENT4_PATH_INSTRUCTIONS: pi ? ' Also read `.claude-path-instructions.md` in the repository root; treat entries as context for what breaks under those paths.' : '',
  };
}
