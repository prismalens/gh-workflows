import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseConfig, fingerprint } from '../src/config.js';

const TOKEN = `asr_${'t'.repeat(43)}`;
const env = { ASSAYER_RUNNER_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-ant-test-value' };
const good = (over = {}) => ({
  control_plane: 'https://assayer.example.test',
  runner_token: '${ASSAYER_RUNNER_TOKEN}',
  placement: 'box',
  credentials: [{ name: 'anthropic', engine: 'claude-code', kind: 'api-key', env: 'ANTHROPIC_API_KEY', concurrency: 1 }],
  ...over,
});

describe('runner config (#184)', () => {
  it('loads a good file with a 12-hex fingerprint that is the key\'s hash, never the key', () => {
    const c = parseConfig(good(), env, { hostname: 'h1' });
    assert.equal(c.runner_token, TOKEN);
    const fp = c.credentials[0].fingerprint;
    assert.match(fp, /^[0-9a-f]{12}$/);
    assert.equal(fp, createHash('sha256').update('sk-ant-test-value').digest('hex').slice(0, 12));
    const json = JSON.stringify(c);
    assert.doesNotMatch(json, /sk-ant-test-value/);
    assert.doesNotMatch(json, new RegExp(TOKEN));
  });

  it('gives a keyless credential a fingerprint stable per host and engine', () => {
    const cfg = good({ credentials: [{ name: 'zen', engine: 'opencode', kind: 'keyless', concurrency: 1 }] });
    const a = parseConfig(cfg, env, { hostname: 'h1' }).credentials[0].fingerprint;
    const b = parseConfig(cfg, env, { hostname: 'h1' }).credentials[0].fingerprint;
    const c = parseConfig(cfg, env, { hostname: 'h2' }).credentials[0].fingerprint;
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(fingerprint('keyless', 'opencode', null, 'h1'), a);
  });

  const refusals = [
    ['a literal runner token', good({ runner_token: TOKEN }), /runner_token must be a \$\{ENV\} reference/],
    ['an unset token variable', good({ runner_token: '${NOPE}' }), /NOPE is not set/],
    ['a malformed token', good(), /is not a runner token/, { ASSAYER_RUNNER_TOKEN: 'asr_short' }],
    ['a placement other than box', good({ placement: 'vps' }), /unknown placement vps/],
    ['user-login', good({ credentials: [{ name: 'u', engine: 'claude-code', kind: 'user-login', concurrency: 1 }] }), /deferred/],
    ['an api-key without env', good({ credentials: [{ name: 'a', engine: 'claude-code', kind: 'api-key', concurrency: 1 }] }), /names its environment variable/],
    ['an unset key variable', good({ credentials: [{ name: 'a', engine: 'claude-code', kind: 'api-key', env: 'MISSING_KEY', concurrency: 1 }] }), /MISSING_KEY is not set/],
    ['an unknown key', { ...good(), extra: 1 }, /config|Unrecognized/],
    ['an unknown engine', good({ credentials: [{ name: 'x', engine: 'gpt', kind: 'api-key', env: 'ANTHROPIC_API_KEY', concurrency: 1 }] }), /unknown engine/],
    ['http to a remote host', good({ control_plane: 'http://assayer.example.test' }), /must be https/],
    ['a path on the control plane', good({ control_plane: 'https://assayer.example.test/api' }), /origin/],
  ];
  for (const [name, raw, pattern, envOver] of refusals) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parseConfig(raw, { ...env, ...(envOver ?? {}) }, { hostname: 'h' }), pattern);
    });
  }

  it('takes several credentials and a concurrency above 1', () => {
    const c = parseConfig(good({ credentials: [
      { name: 'a', engine: 'claude-code', kind: 'api-key', env: 'ANTHROPIC_API_KEY', concurrency: 2 },
      { name: 'z', engine: 'opencode', kind: 'keyless', concurrency: 3 }] }), env, { hostname: 'h' });
    assert.equal(c.placement, 'box');
    assert.deepEqual(c.credentials.map((x) => x.concurrency), [2, 3]);
  });

  it('allows http to localhost for tests', () => {
    assert.equal(parseConfig(good({ control_plane: 'http://127.0.0.1:8787' }), env).control_plane, 'http://127.0.0.1:8787');
  });
});

it('claude-code offers no user-login kind (#184)', async () => {
  const { ENGINES } = await import('../src/engines.js');
  assert.ok(!ENGINES['claude-code'].credentialKinds.includes('user-login'));
});
