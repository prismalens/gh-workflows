#!/usr/bin/env node
// Render the lane's prompt template for one round, computing the round-type tokens the way
// the workflow's build-prompt env block does. Prints the prompt on stdout, the prompt hash on
// stderr. Usage: render-prompt.mjs --repo owner/name --pr N [--level medium|high]
//   [--mode review|review-full|incremental --range-base SHA --range-head SHA] [--path-instructions]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPrompt, promptHash } from '../src/prompt.js';

const args = process.argv.slice(2);
const get = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const repo = get('--repo'); const pr = get('--pr');
if (!repo || !pr || !/^[^/]+\/[^/]+$/.test(repo) || !/^\d+$/.test(pr)) { console.error('usage: --repo owner/name --pr N'); process.exit(2); }
const level = get('--level', 'medium'); const mode = get('--mode', 'review');
if (!['review', 'review-full', 'incremental'].includes(mode)) { console.error('bad --mode'); process.exit(2); }
const rb = get('--range-base'); const rh = get('--range-head');
if (mode === 'incremental' && !(rb && rh)) { console.error('incremental needs --range-base and --range-head'); process.exit(2); }
const inc = mode === 'incremental'; const full = mode === 'review-full'; const pi = has('--path-instructions');
const short = (s) => String(s).slice(0, 7);

// Verbatim from the workflow's build-prompt env block (claude-code-review.yml). Re-sync with it.
const tokens = {
  REPO: repo, PR_NUMBER: pr, LEVEL: level,
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
const template = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompt', 'template.md'), 'utf8');
const out = renderPrompt(template, tokens);
if (/@@[A-Z0-9_]+@@/.test(out)) { console.error('render left a placeholder: ' + out.match(/@@[A-Z0-9_]+@@/g).join(' ')); process.exit(1); }
process.stderr.write(`prompt_hash=${promptHash(template)}\n`);
process.stdout.write(out);
