import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ENGINES } from '../src/engines.js';

const proxy = { baseURL: 'http://127.0.0.1:8787', token: 'nonce-0123456789abcdef' };
const outDir = () => mkdtempSync(path.join(tmpdir(), 'eng-'));

it('claude-code behind the proxy: base URL and nonce, and no other key survives (#184)', () => {
  const env = ENGINES['claude-code'].prepare({ model: null, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-real', ANTHROPIC_AUTH_TOKEN: 'tok-real' }, proxy });
  assert.equal(env.ANTHROPIC_BASE_URL, proxy.baseURL);
  assert.equal(env.ANTHROPIC_API_KEY, proxy.token);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(env), /sk-real|tok-real/);
});

it('claude-code without a proxy is unchanged', () => {
  const env = ENGINES['claude-code'].prepare({ model: 'm', env: { PATH: '/bin' } });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ANTHROPIC_MODEL: 'm' });
});

it('opencode behind the proxy points the model\'s provider at it with the nonce', () => {
  const dir = outDir();
  ENGINES.opencode.prepare({ model: 'opencode/muse-spark-1.3-contributor-free', outDir: dir, env: {}, proxy });
  const cfg = JSON.parse(readFileSync(path.join(dir, 'engine-config', 'opencode.json'), 'utf8'));
  assert.deepEqual(cfg.provider, { opencode: { options: { baseURL: proxy.baseURL, apiKey: proxy.token } } });
  assert.equal(cfg.permission.bash, 'ask');
});

it('opencode without a proxy writes no provider block', () => {
  const dir = outDir();
  ENGINES.opencode.prepare({ model: 'opencode/x', outDir: dir, env: {} });
  const cfg = JSON.parse(readFileSync(path.join(dir, 'engine-config', 'opencode.json'), 'utf8'));
  assert.equal(cfg.provider, undefined);
});

it('opencode behind the proxy refuses a model with no provider prefix', () => {
  assert.throws(() => ENGINES.opencode.prepare({ model: 'bare', outDir: outDir(), env: {}, proxy }), /names no provider/);
});
