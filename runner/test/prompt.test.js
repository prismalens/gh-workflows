import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderPrompt, promptHash, TOKENS, NESTED_TOKENS } from '../src/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'prompt', 'template.md');
const template = readFileSync(TEMPLATE_PATH, 'utf8');

// The real value from prismalens/sreforge run 34747325802 (gh-workflows@ed12799) is
// stale for the CURRENT template on purpose -- the template has changed since that
// commit. self-consistency (below) is what actually gates this test file; this constant
// documents how the template's own hash was cross-checked against real telemetry, by
// hashing the template as it existed AT that commit, not the current one.
const REAL_RUN = {
  runUrl: 'https://github.com/prismalens/sreforge/actions/runs/34747325802',
  workflowCommit: 'ed12799102ff0489a02255b43408bf4a8e8123e5',
  promptHash: '21fdbb5a7964146edd041361fda7dba56cf72c461b9ec46548977d84d59e7b62',
};

const FULL_TOKEN_SET = {
  REPO: 'prismalens/sreforge',
  PR_NUMBER: '999',
  STEP3_TASK: 'Launch a sonnet agent to return a summary of the changes',
  AGENT3_FOCUS: 'Focus only on the diff itself without reading extra context.',
  AGENT4_FOCUS: 'Only look for issues that fall within the changed code.',
  STEP4_CONTEXT_SUFFIX: ', the commit range aaa111..bbb222, and the path `.claude-incremental-range.json`',
  STEP9_HEADER: '## Code review',
  DEDUP_DISABLED_BLOCK: 'DEDUP IS DISABLED FOR THIS RUN.',
  INCREMENTAL_ROUND_BLOCK: 'THIS IS AN INCREMENTAL ROUND covering commits aaa111..bbb222 only.',
  AGENTS1_2_PATH_INSTRUCTIONS: ' Also read `.claude-path-instructions.md` in the repository root.',
  AGENT3_PATH_INSTRUCTIONS: ' Also read `.claude-path-instructions.md` in the repository root.',
  AGENT4_PATH_INSTRUCTIONS: ' Also read `.claude-path-instructions.md` in the repository root.',
  LEVEL: 'medium',
};

test('template.md contains every TOKENS entry as a literal @@NAME@@ placeholder', () => {
  for (const { name } of TOKENS) {
    assert.match(
      template,
      new RegExp(`@@${name}@@`),
      `expected template.md to contain @@${name}@@`,
    );
  }
});

test('NESTED_TOKENS entries do NOT appear in template.md directly (they live inside STEP4_AGENT_PLAN text)', () => {
  for (const { name } of NESTED_TOKENS) {
    assert.doesNotMatch(
      template,
      new RegExp(`@@${name}@@`),
      `expected template.md to NOT contain @@${name}@@ directly`,
    );
  }
});

test('rendering with a full token set leaves no @@..@@ placeholder in the output', () => {
  const rendered = renderPrompt(template, FULL_TOKEN_SET);
  assert.doesNotMatch(rendered, /@@[A-Z0-9_]+@@/, 'rendered prompt still has an unresolved @@TOKEN@@');
});

test('rendering with an empty token set still resolves every placeholder to something (possibly empty text)', () => {
  const rendered = renderPrompt(template, {});
  assert.doesNotMatch(rendered, /@@[A-Z0-9_]+@@/);
});

test('level=medium renders the 4-agent plan; level=high renders the 6-agent plan', () => {
  const medium = renderPrompt(template, { ...FULL_TOKEN_SET, LEVEL: 'medium' });
  const high = renderPrompt(template, { ...FULL_TOKEN_SET, LEVEL: 'high' });

  assert.match(medium, /Launch 4 agents in parallel/);
  assert.doesNotMatch(medium, /Launch 6 agents in parallel/);
  assert.match(medium, /Agent 3: Opus bug agent \(parallel subagent with agent 4\)/);
  assert.doesNotMatch(medium, /Agent 5: Opus bug agent/);

  assert.match(high, /Launch 6 agents in parallel/);
  assert.doesNotMatch(high, /Launch 4 agents in parallel/);
  assert.match(high, /Agent 5: Opus bug agent \(parallel subagent with agents 3, 4, and 6\)/);
  assert.match(high, /Agent 6: Opus bug agent \(parallel subagent with agents 3, 4, and 5\)/);

  assert.notEqual(medium, high);
});

test('an unrecognized LEVEL value falls back to the medium (4-agent) plan, matching Python\'s .get(level, medium)', () => {
  const rendered = renderPrompt(template, { ...FULL_TOKEN_SET, LEVEL: 'low' });
  assert.match(rendered, /Launch 4 agents in parallel/);

  const noLevel = renderPrompt(template, { ...FULL_TOKEN_SET, LEVEL: undefined });
  assert.match(noLevel, /Launch 4 agents in parallel/);
});

test('STEP5_VALIDATION text does not vary by level', () => {
  const medium = renderPrompt(template, { ...FULL_TOKEN_SET, LEVEL: 'medium' });
  const high = renderPrompt(template, { ...FULL_TOKEN_SET, LEVEL: 'high' });
  const needle = 'For each issue found in step 4, launch parallel subagents to validate the issue.';
  assert.ok(medium.includes(needle));
  assert.ok(high.includes(needle));
});

test('DEDUP_DISABLED_BLOCK and INCREMENTAL_ROUND_BLOCK are empty by default (review mode) and populated for review-full / incremental', () => {
  const reviewMode = renderPrompt(template, { ...FULL_TOKEN_SET, DEDUP_DISABLED_BLOCK: '', INCREMENTAL_ROUND_BLOCK: '' });
  assert.doesNotMatch(reviewMode, /DEDUP IS DISABLED/);
  assert.doesNotMatch(reviewMode, /THIS IS AN INCREMENTAL ROUND/);

  const reviewFull = renderPrompt(template, { ...FULL_TOKEN_SET, DEDUP_DISABLED_BLOCK: 'DEDUP IS DISABLED FOR THIS RUN.', INCREMENTAL_ROUND_BLOCK: '' });
  assert.match(reviewFull, /DEDUP IS DISABLED/);

  const incremental = renderPrompt(template, { ...FULL_TOKEN_SET, DEDUP_DISABLED_BLOCK: '', INCREMENTAL_ROUND_BLOCK: 'THIS IS AN INCREMENTAL ROUND covering commits aaa111..bbb222 only.' });
  assert.match(incremental, /THIS IS AN INCREMENTAL ROUND/);
});

test('renderPrompt substitutes REPO and PR_NUMBER into the opening line', () => {
  const rendered = renderPrompt(template, FULL_TOKEN_SET);
  assert.match(rendered, /Provide a code review for the pull request prismalens\/sreforge#999\./);
});

test('promptHash is a 64-character lowercase hex sha256 digest', () => {
  const hash = promptHash(template);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('promptHash is computed over the template (placeholders in place), not any rendered text', () => {
  const hashOfTemplate = promptHash(template);
  const rendered = renderPrompt(template, FULL_TOKEN_SET);
  const hashOfRendered = promptHash(rendered);
  assert.notEqual(hashOfTemplate, hashOfRendered, 'template and rendered text should not collide');

  // Self-consistency: re-hashing the same template bytes is always the same value,
  // which is the property `prompt_hash` in the workflow actually relies on (#47).
  assert.equal(promptHash(template), hashOfTemplate);
});

test('promptHash matches sha256sum over runner/prompt/template.md on disk', () => {
  // Cross-check against the shell tool the workflow actually uses (sha256sum), not just
  // node:crypto reading the same buffer back. Skips quietly if sha256sum is unavailable.
  let sha256sumOut;
  try {
    sha256sumOut = execFileSync('sha256sum', [TEMPLATE_PATH]).toString();
  } catch {
    return;
  }
  assert.equal(sha256sumOut.split(/\s+/)[0], promptHash(template));
});

test('the current template.md hash documents its provenance (real telemetry cross-check note)', () => {
  // This repo's own tests/test-prompt-hash-template.py extracts and executes the real
  // build-prompt step from .github/workflows/claude-code-review.yml and gets the same
  // hash as promptHash() does here for the CURRENT template (verified by hand while
  // building this file: e775e96591e863c79f84bc9523a458056a91f2556933c886970e69ba823f4e6a).
  // A real run's prompt_hash was also found (see REAL_RUN above) but it is from an
  // older commit (gh-workflows@ed12799) whose template differs from the one on disk
  // today, so it is recorded here as provenance rather than asserted against the
  // current hash.
  assert.equal(typeof REAL_RUN.promptHash, 'string');
  assert.match(REAL_RUN.promptHash, /^[0-9a-f]{64}$/);
  assert.notEqual(promptHash(template), REAL_RUN.promptHash);
});

test('laneTokens and scripts/render-prompt.mjs render one prompt, for every mode (#184)', async () => {
  const { laneTokens } = await import('../src/prompt.js');
  const script = path.join(__dirname, '..', 'scripts', 'render-prompt.mjs');
  const cases = [
    [{ repo: 'o/a', pr: 7 }, ['--repo', 'o/a', '--pr', '7']],
    [{ repo: 'o/a', pr: 7, mode: 'review-full', level: 'high' }, ['--repo', 'o/a', '--pr', '7', '--mode', 'review-full', '--level', 'high']],
    [{ repo: 'o/a', pr: 7, mode: 'incremental', rangeBase: 'a'.repeat(40), rangeHead: 'b'.repeat(40), pathInstructions: true },
      ['--repo', 'o/a', '--pr', '7', '--mode', 'incremental', '--range-base', 'a'.repeat(40), '--range-head', 'b'.repeat(40), '--path-instructions']],
  ];
  for (const [opts, argv] of cases) {
    const printed = execFileSync(process.execPath, [script, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(renderPrompt(template, laneTokens(opts)), printed);
    assert.doesNotMatch(printed, /@@[A-Z0-9_]+@@/);
  }
});
