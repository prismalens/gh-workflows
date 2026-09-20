import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, chooseOption, commandAllowed, LANE_ALLOWED_TOOLS } from '../src/policy.js';

test('the allowlist is the lane\'s, with gh pr review absent', () => {
  assert.ok(LANE_ALLOWED_TOOLS.includes('Bash(gh pr diff:*)'));
  assert.ok(!LANE_ALLOWED_TOOLS.some((t) => t.includes('gh pr review')));
});

test('gh read commands pass, everything else on execute is rejected', () => {
  for (const c of ['gh pr diff 183', 'gh pr view 183 --json files', 'gh issue list', 'gh search issues x', 'gh pr view 183 2>/dev/null', 'gh pr diff 183 2>&1', 'gh  pr   view 1']) assert.equal(commandAllowed(c), true, c);
  for (const c of ['gh pr review 183 --approve', 'gh pr merge 183', 'rm -rf /', 'gh pr diff 183; rm x', 'gh pr diff 183 | sh',
    'gh pr diff 183 > out', 'gh pr diff $(x)', 'gh pr diffx', '', 'ghpr diff', 'gh pr view 1 2>&1 | head -c 4000', 'gh pr view 1 2>err.log', 'gh pr view 1 >/dev/null',
    'gh pr view 1\ncat ~/.config/gh/hosts.yml', 'gh pr view 1\r\nenv', 'gh pr view 1\n/usr/bin/gh pr review 1 --approve', 'gh pr view\x001', 'gh pr view 1\x1b[0m']) assert.equal(commandAllowed(c), false, c);
  assert.equal(commandAllowed('gh pr view 1\t--json title'), true, 'a tab is ordinary whitespace');
});

test('decide by kind, by command, by comment tool name', () => {
  assert.equal(decide({ kind: 'read', title: 'Read src/a.js' }).allow, true);
  assert.equal(decide({ kind: 'search' }).allow, true);
  assert.equal(decide({ kind: 'edit', title: 'Edit a.js' }).allow, false);
  assert.equal(decide({ kind: 'delete' }).allow, false);
  assert.equal(decide({ kind: 'fetch', rawInput: { url: 'http://x' } }).allow, false);
  assert.equal(decide({ kind: 'execute', rawInput: { command: 'gh pr diff 1' } }).allow, true);
  assert.equal(decide({ kind: 'execute', rawInput: { command: 'cat /etc/passwd' } }).allow, false);
  assert.equal(decide({ kind: 'execute', rawInput: {} }).allow, false, 'execute without a command');
  assert.equal(decide({ kind: 'execute', rawInput: 'gh pr diff 1' }).allow, false, 'rawInput not an object');
  assert.equal(decide({ kind: 'other', name: 'mcp__github_inline_comment__create_inline_comment' }).allow, true);
  assert.equal(decide({ kind: 'other', name: 'mcp__github__merge_pull_request' }).allow, false);
  // A title is not an authenticated identity: a crafted prefix with the same suffix is refused,
  // while the bare titles the recorded round actually sends still pass.
  assert.equal(decide({ kind: 'other', name: 'mcp__evil__create_inline_comment' }).allow, false, 'crafted prefix');
  assert.equal(decide({ kind: 'other', title: 'mcp__attacker__update_claude_comment' }).allow, false, 'crafted prefix by title');
  assert.equal(decide({ kind: 'other', title: 'create_inline_comment' }).allow, true, 'the bare title form');
  assert.equal(decide({ kind: 'other', title: 'update_claude_comment' }).allow, true, 'the bare title form');
  assert.equal(decide({}).allow, false, 'no kind at all');
});

test('chooseOption prefers once-only forms and returns null when none fit', () => {
  const opts = [{ optionId: 'a', kind: 'allow_always' }, { optionId: 'b', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }];
  assert.equal(chooseOption(opts, true), 'b');
  assert.equal(chooseOption(opts, false), 'r');
  assert.equal(chooseOption([{ optionId: 'a', kind: 'allow_always' }], false), null);
  assert.equal(chooseOption([], true), null);
});
