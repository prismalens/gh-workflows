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

test('a gh pr comment body spans lines only inside inert quotes', () => {
  for (const c of [
    'gh pr comment 221 --repo o/r --body "## Code review\nNo issues found. The operator\'s note stays."',
    "gh pr comment 221 --body '## Code review\n`a.js` has $HOME in it'",
    'gh pr comment 221 -b "one\ntwo" --repo o/r',
  ]) assert.equal(commandAllowed(c), true, c);
  for (const c of [
    'gh pr comment 221 --body "x\n`id`"', 'gh pr comment 221 --body "x\n$(id)"', 'gh pr comment 221 --body "a\\"\nid"',
    "gh pr comment 221 --body 'a'\nid", "gh pr comment 221 --body 'a'; id", 'gh pr review 221 --body "x\ny"',
    'gh pr comment 221 --body "x\ny" | sh', 'gh pr comment 221 --body "x" "y\nz"',
    "gh pr comment 221 --body 'a\x1b[2Jb'", 'gh pr comment 221 --body "a\x00b"', "gh pr comment 221 --body 'a\r\nb'",
  ]) assert.equal(commandAllowed(c), false, c);
});

test('Codex command shapes: argv behind a shell, and a script quoted into one word', () => {
  assert.equal(decide({ kind: 'execute', rawInput: { command: ['/bin/bash', '-lc', 'gh pr list --limit 1'] } }).allow, true);
  assert.equal(decide({ kind: 'execute', rawInput: { command: ['/bin/bash', '-lc', 'cat ~/.codex/auth.json'] } }).allow, false);
  assert.equal(decide({ kind: 'execute', rawInput: { command: ['gh', 'pr', 'list'] } }).allow, false, 'bare argv is refused');
  assert.equal(decide({ kind: 'execute', rawInput: { command: '"gh pr comment 1 --body \\"## Code review\nNo issues.\\""' } }).allow, true);
  assert.equal(decide({ kind: 'execute', rawInput: { command: '"gh pr comment 1 --body \\"x\n\\$(id)\\""' } }).allow, false);
});

test('Codex MCP approvals: only the two comment tools pass, by server and tool', () => {
  const mcp = (server, tool) => decide({ kind: 'execute', title: `mcp.${server}.${tool}`, rawInput: { server, tool, arguments: {} } });
  assert.equal(mcp('github_inline_comment', 'create_inline_comment').allow, true);
  assert.equal(mcp('github_comment', 'update_claude_comment').allow, true);
  for (const [s, t] of [['github_comment', 'create_inline_comment'], ['evil', 'create_inline_comment'], ['github_inline_comment', 'delete_comment'], ['shell', 'exec']]) {
    assert.equal(mcp(s, t).allow, false, `${s}/${t}`);
  }
  assert.equal(decide({ kind: 'execute', rawInput: { server: 1, tool: 'create_inline_comment' } }).allow, false);
});

test('an apostrophe in a single-quoted body, and a word Codex quotes in mixed styles', () => {
  assert.equal(commandAllowed("gh pr comment 8 --body '## Code review\nThe author'\"'\"'s change is fine.'"), true);
  for (const c of [
    "gh pr comment 8 --body 'a'\"'\"'b'; id", "gh pr comment 8 --body 'a'\"$(id)\"'b'",
    "gh pr comment 8 --body 'a'\"'\"'b' | sh",
  ]) assert.equal(commandAllowed(c), false, c);
  const word = (s) => decide({ kind: 'execute', rawInput: { command: s } }).allow;
  assert.equal(word("\"gh pr comment 8 --body '## Code review\nhead \"'`abc`'\" is fine.'\""), true);
  assert.equal(word("\"gh pr comment 8 --body 'x' \"'; id'"), false);
  assert.equal(word("\"gh pr view 8 \"\"$(id)\""), false);
  assert.equal(word("\"gh pr view 8 \"'`id`'"), false);
});
