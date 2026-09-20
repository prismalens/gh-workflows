import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/run.js';

test('parseArgs validates', () => {
  const o = parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--model', 'x/y', '--timeout-min', '5']);
  assert.equal(o.engine, 'opencode'); assert.equal(o.timeoutMs, 300000); assert.equal(o.model, 'x/y');
  assert.throws(() => parseArgs(['--cwd', '/c']), /--prompt is required/);
  assert.throws(() => parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--engine', 'nope']), /unknown engine/);
  assert.throws(() => parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--timeout-min', '0']), /positive/);
  assert.throws(() => parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--idle-min', 'x']), /idle-min/);
  assert.equal(parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--idle-min', '2']).idleMs, 120000);
  assert.throws(() => parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--bogus', '1']), /unknown argument/);
  assert.throws(() => parseArgs(['--cwd']), /needs a value/);
});

test('--stage-manifest needs a repo and a PR number, and a sane sha', () => {
  const base = ['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--stage-manifest'];
  assert.throws(() => parseArgs(base), /--repo/);
  assert.throws(() => parseArgs([...base, '--repo', 'bad', '--pr', '1']), /--repo/);
  assert.throws(() => parseArgs([...base, '--repo', 'o/r']), /--pr/);
  assert.throws(() => parseArgs([...base, '--repo', 'o/r', '--pr', 'x']), /--pr/);
  assert.throws(() => parseArgs([...base, '--repo', 'o/r', '--pr', '1', '--head-sha', 'zz']), /hex/);
  const o = parseArgs([...base, '--repo', 'o/r', '--pr', '1', '--head-sha', 'abc1234']);
  assert.equal(o.stage, true); assert.equal(o.mode, 'review');
  assert.equal(parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o']).stage, false, 'staging is opt-in');
});
