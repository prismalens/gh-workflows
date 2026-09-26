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

test('--head-sha defaults to empty, never null: a null reaches manifest.py as the string "null"', () => {
  // `headSha = ''` in buildManifest is a JS default, which fires only for undefined, so a null
  // was passed straight through and spawn stringified it. Staging then refused every round with
  // "head moved from null to <sha>" unless --head-sha was given by hand.
  const o = parseArgs(['--stage-manifest', '--repo', 'owner/name', '--pr', '7', '--cwd', '.', '--prompt', 'p.md', '--out', 'o']);
  assert.equal(o.headSha, '');
  assert.notEqual(o.headSha, null);
});

test('parseArgs takes the daemon\'s credential flags (#184)', () => {
  const base = ['--cwd', '/c', '--prompt', '/p', '--out', '/o'];
  const o = parseArgs([...base, '--credential-env', 'ANTHROPIC_API_KEY', '--credential-fingerprint', 'abcdef012345']);
  assert.equal(o.credentialEnv, 'ANTHROPIC_API_KEY');
  assert.equal(o.credentialFingerprint, 'abcdef012345');
  assert.equal(parseArgs(base).credentialEnv, null);
  assert.throws(() => parseArgs([...base, '--credential-fingerprint', 'ABC']), /12 lowercase hex/);
  assert.throws(() => parseArgs([...base, '--credential-env', 'bad-name']), /environment variable name/);
});

test('engineEnv passes one extra credential variable and nothing else (#184)', async () => {
  const { ENGINES, engineEnv } = await import('../src/engines.js');
  const env = engineEnv(ENGINES.opencode, { PATH: '/bin', MY_KEY: 'k', OTHER: 'x' }, ['MY_KEY']);
  assert.deepEqual(env, { PATH: '/bin', MY_KEY: 'k' });
  assert.deepEqual(engineEnv(ENGINES.opencode, { PATH: '/bin', MY_KEY: 'k' }), { PATH: '/bin' });
});

test('--proxy-base-url needs the round\'s nonce, and --staged-json replaces staging (#184)', () => {
  const base = ['--cwd', '/c', '--prompt', '/p', '--out', '/o'];
  assert.throws(() => parseArgs([...base, '--proxy-base-url', 'http://127.0.0.1:8787'], {}), /ASSAYER_PROXY_TOKEN/);
  const o = parseArgs([...base, '--proxy-base-url', 'http://127.0.0.1:8787', '--staged-json', '/round/staged.json'], { ASSAYER_PROXY_TOKEN: 'n' });
  assert.equal(o.proxyBaseUrl, 'http://127.0.0.1:8787');
  assert.equal(o.stagedJson, '/round/staged.json');
  assert.throws(() => parseArgs([...base, '--stage-manifest', '--repo', 'o/r', '--pr', '1', '--staged-json', '/s'], {}), /exclusive/);
});
