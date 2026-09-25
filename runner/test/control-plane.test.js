import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlane, ControlPlaneError, fitEvent, batches, redact, MAX_EVENT_BYTES } from '../src/control-plane.js';
import { revokeInstallationToken, checkout } from '../src/github.js';
import { event } from '../src/events.js';
import { EventEmitter } from 'node:events';

describe('control-plane client (#184)', () => {
  it('sends the runner token, the lease query and JSON bodies in the Worker\'s shapes', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/lease')) return new Response(null, { status: 204 });
      if (String(url).includes('/register')) return new Response(JSON.stringify({ runner_id: 'r' }), { status: 200 });
      return new Response(null, { status: 204 });
    };
    const cp = createControlPlane({ baseUrl: 'https://cp.test', token: 'asr_x', fetch });
    assert.deepEqual(await cp.register({ placement: 'box', credentials: [{ name: 'n', engine: 'opencode', kind: 'keyless', fingerprint: 'abcdefabcdef', concurrency: 1, env: null }] }), { runner_id: 'r' });
    assert.equal(await cp.lease({ engine: 'opencode', kind: 'keyless', wait: 20 }), null);
    await cp.postEvents('job 1', []);
    assert.deepEqual(JSON.parse(calls[0].init.body), { placement: 'box', credentials: [{ engine: 'opencode', kind: 'keyless', fingerprint: 'abcdefabcdef', concurrency: 1 }] });
    assert.equal(calls[1].url, 'https://cp.test/runner/lease?engine=opencode&kind=keyless&wait=20');
    assert.equal(calls[2].url, 'https://cp.test/runner/jobs/job%201/events');
    assert.deepEqual(JSON.parse(calls[2].init.body), { events: [] });
    for (const c of calls) assert.equal(c.init.headers.Authorization, 'Bearer asr_x');
  });

  it('turns an error body into ControlPlaneError, and a network failure into status 0', async () => {
    const cp = createControlPlane({ baseUrl: 'https://cp.test', token: 't', fetch: async () => new Response(JSON.stringify({ error: 'lease-lost' }), { status: 409 }) });
    await assert.rejects(cp.postEvents('j', []), (e) => e instanceof ControlPlaneError && e.status === 409 && e.code === 'lease-lost');
    const down = createControlPlane({ baseUrl: 'https://cp.test', token: 't', fetch: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(down.postEvents('j', []), (e) => e.status === 0 && e.code === 'network');
  });

  it('cuts an event over 16 KiB and marks it truncated', () => {
    const big = event('finding', { path: 'a.js', body: 'x'.repeat(40000), ai_prompt: 'y'.repeat(5000) });
    const fit = fitEvent(big);
    assert.ok(Buffer.byteLength(JSON.stringify(fit)) <= MAX_EVENT_BYTES);
    assert.equal(fit._meta.truncated, true);
    const small = event('read', { path: 'a.js' });
    assert.equal(fitEvent(small), small);
  });

  it('batches by 100 and redacts every secret', () => {
    assert.deepEqual(batches(Array.from({ length: 201 }, (_, i) => i)).map((b) => b.length), [100, 100, 1]);
    assert.equal(redact('a TOKEN b TOKEN', new Set(['TOKEN'])), 'a [redacted] b [redacted]');
    assert.equal(redact('nothing', new Set()), 'nothing');
  });
});

describe('github calls (#184)', () => {
  it('revokes with DELETE /installation/token and never throws', async () => {
    let seen;
    const ok = await revokeInstallationToken('ghs_1', { fetch: async (url, init) => { seen = { url: String(url), init }; return new Response(null, { status: 204 }); } });
    assert.equal(ok, true);
    assert.equal(seen.url, 'https://api.github.com/installation/token');
    assert.equal(seen.init.method, 'DELETE');
    assert.equal(seen.init.headers.Authorization, 'Bearer ghs_1');
    assert.equal(seen.init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(await revokeInstallationToken('t', { fetch: async () => new Response(null, { status: 401 }) }), false);
    assert.equal(await revokeInstallationToken('t', { fetch: async () => { throw new Error('down'); } }), false);
  });

  it('checks out with the token only in GIT_CONFIG_VALUE_0, never in argv', async () => {
    const spawned = [];
    const spawn = (cmd, args, opts) => {
      spawned.push({ cmd, args, env: opts.env });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    await checkout({ repository: 'o/r', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), token: 'ghs_secret', dir: '/tmp/x', spawn });
    assert.deepEqual(spawned.map((s) => s.args[0]), ['init', 'fetch', 'checkout']);
    for (const s of spawned) {
      assert.doesNotMatch(s.args.join(' '), /ghs_secret/);
      assert.equal(s.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
      assert.equal(s.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`);
      assert.deepEqual(Object.keys(s.env).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH']);
    }
    assert.deepEqual(spawned[1].args.slice(-2), ['a'.repeat(40), 'b'.repeat(40)]);
  });
});
