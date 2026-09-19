import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whichGh } from '../src/run.js';

const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gh-shim.sh');

function setup() {
  const d = mkdtempSync(path.join(tmpdir(), 'ghshim-'));
  const fake = path.join(d, 'fake-gh');
  writeFileSync(fake, '#!/usr/bin/env bash\necho "REAL:$*"\n'); chmodSync(fake, 0o755);
  const log = path.join(d, 'tool-log.jsonl'); writeFileSync(log, '');
  const env = { ...process.env, ASSAYER_TOOL_LOG: log, ASSAYER_REAL_GH: fake };
  const run = (args, input) => spawnSync('bash', [shim, ...args], { env, input, encoding: 'utf8' });
  const entries = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { d, run, entries };
}

test('pr comment is recorded, never forwarded; every body form works', () => {
  const { d, run, entries } = setup();
  assert.equal(run(['pr', 'comment', '183', '--body', 'hello']).status, 0);
  assert.equal(run(['pr', 'comment', '183', '--body=eq form']).status, 0);
  const f = path.join(d, 'b.md'); writeFileSync(f, '## header\nfrom file');
  assert.equal(run(['pr', 'comment', '183', '--body-file', f]).status, 0);
  assert.equal(run(['pr', 'comment', '183', '-F', '-'], 'from stdin').status, 0);
  const e = entries();
  assert.deepEqual(e.map((x) => x.input.body), ['hello', 'eq form', '## header\nfrom file', 'from stdin']);
  assert.ok(e.every((x) => x.tool === 'gh_pr_comment' && x.input.args.includes('183')));
  const r = run(['pr', 'comment', '183', '--body', 'x']); assert.match(r.stdout, /issuecomment-recorded/);
  assert.ok(!r.stdout.includes('REAL:'));
});

test('pr comment without a body, or with an unreadable file, fails without recording', () => {
  const { run, entries } = setup();
  assert.notEqual(run(['pr', 'comment', '183']).status, 0);
  assert.notEqual(run(['pr', 'comment', '183', '--body-file', '/nonexistent']).status, 0);
  assert.notEqual(run(['pr', 'comment', '183', '--body', '']).status, 0);
  assert.equal(entries().length, 0);
});

test('write-shaped subcommands are refused, reads go to the real gh', () => {
  const { run } = setup();
  for (const a of [['pr', 'review', '1', '--approve'], ['pr', 'merge', '1'], ['pr', 'close', '1'], ['api', 'repos/x/y/pulls/1/reviews']]) {
    const r = run(a); assert.notEqual(r.status, 0, a.join(' ')); assert.ok(!r.stdout.includes('REAL:'));
  }
  assert.equal(run(['pr', 'diff', '183']).stdout.trim(), 'REAL:pr diff 183');
  assert.equal(run(['issue', 'view', '5', '--json', 'title']).stdout.trim(), 'REAL:issue view 5 --json title');
  assert.equal(run([]).stdout.trim(), 'REAL:');
});

test('whichGh finds an executable named gh on PATH and skips directories', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'wg-'));
  assert.equal(whichGh(`${d}:/nonexistent`), null);
  const g = path.join(d, 'gh'); writeFileSync(g, '#!/bin/sh\n'); chmodSync(g, 0o755);
  assert.equal(whichGh(`/nonexistent:${d}`), g);
});
