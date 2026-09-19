import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/run.js';

test('parseArgs validates', () => {
  const o = parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--model', 'x/y', '--timeout-min', '5']);
  assert.equal(o.engine, 'opencode'); assert.equal(o.timeoutMs, 300000); assert.equal(o.model, 'x/y');
  assert.throws(() => parseArgs(['--cwd', '/c']), /--prompt is required/);
  assert.throws(() => parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--engine', 'nope']), /unknown engine/);
  assert.throws(() => parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--timeout-min', '0']), /positive/);
  assert.throws(() => parseArgs(['--cwd', '/c', '--prompt', '/p', '--out', '/o', '--bogus', '1']), /unknown argument/);
  assert.throws(() => parseArgs(['--cwd']), /needs a value/);
});
