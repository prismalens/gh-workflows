import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDaemon, containerReady, CONTAINER_NOT_READY } from '../src/daemon.js';
import { event } from '../src/events.js';
import { ControlPlaneError } from '../src/control-plane.js';

// Every loop test runs as if the container slice had landed.
const ready = () => true;
const RUNNER_TOKEN = `asr_${'r'.repeat(43)}`;
const INSTALL_TOKEN = 'ghs_install_token_1';
const KEY = 'sk-test-credential-value';
const JOB = {
  id: '11111111-1111-4111-8111-111111111111', repository: 'prismalens/sreforge', pr_number: 183,
  base_sha: 'b'.repeat(40), head_sha: 'a'.repeat(40), mode: 'review', level: 'medium', model: null,
  engine: 'opencode', credential_kind: 'api-key', config_effective: null, attempt: 1,
};

function config(concurrency = 1) {
  const c = {
    control_plane: 'http://127.0.0.1:9', placement: 'box',
    credentials: [{ name: 'k', engine: 'opencode', kind: 'api-key', env: 'OPENCODE_KEY', concurrency, fingerprint: 'abcdefabcdef' }],
  };
  Object.defineProperty(c, 'runner_token', { value: RUNNER_TOKEN, enumerable: false });
  Object.defineProperty(c, 'secrets', { value: new Map([['k', KEY]]), enumerable: false });
  return c;
}

// One fetch for the control plane and GitHub, so call order across hosts is one list.
function world({ jobs = [JOB], eventsStatus = () => 204, revokeStatus = 204, leaseError = null, leaseErrorAt = () => false } = {}) {
  const calls = [];
  const queue = [...jobs];
  let leaseErrorsLeft = leaseError ? 1 : 0;
  let leases = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const method = init.method ?? 'GET';
    calls.push({ method, path: u.pathname, body, auth: init.headers?.Authorization });
    if (u.pathname === '/runner/register') {
      return new Response(JSON.stringify({ runner_id: 'r1', credentials: [], heartbeat_timeout_s: 300, lease_wait_max_s: 0 }), { status: 200 });
    }
    if (u.pathname === '/runner/lease') {
      leases += 1;
      if (leaseErrorAt(leases)) return new Response(JSON.stringify({ error: 'unregistered-credential' }), { status: 409 });
      if (leaseErrorsLeft > 0) { leaseErrorsLeft -= 1; return new Response(JSON.stringify({ error: leaseError }), { status: 409 }); }
      const job = queue.shift();
      if (!job) { await new Promise((r) => setTimeout(r, 5)); return new Response(null, { status: 204 }); }
      return new Response(JSON.stringify({ job, installation_token: INSTALL_TOKEN, installation_token_expires_at: 'x', heartbeat_timeout_s: 300 }), { status: 200 });
    }
    if (u.pathname.startsWith('/runner/jobs/')) {
      const status = eventsStatus(body.events, calls);
      return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify({ error: status === 409 ? 'lease-lost' : 'x' }), { status });
    }
    if (u.pathname === '/installation/token' && method === 'DELETE') return new Response(null, { status: revokeStatus });
    return new Response(null, { status: 404 });
  };
  return { fetch, calls };
}

// The calls that matter for the order: non-empty event posts and the revoke.
function sequence(calls) {
  return calls
    .filter((c) => (c.path.startsWith('/runner/jobs/') && c.body.events.length) || c.path === '/installation/token')
    .map((c) => (c.path === '/installation/token' ? 'revoke' : c.body.events.map((e) => e.type).join('+')));
}

const roundEvents = (conclusion = 'completed') => [
  event('started', { engine: 'opencode' }), event('summary', { header: 'h', body: 'b' }), event('finished', { conclusion }),
];

async function runOne(w, deps = {}, cfg = config()) {
  const logs = [];
  let dirs = [];
  const d = await startDaemon(cfg, { containerReady: ready,
    fetch: w.fetch, heartbeatMs: 20, backoffUnitMs: 1, log: (l) => logs.push(l),
    checkout: async () => {}, mkTemp: (p) => { const x = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(x); return x; },
    runRound: async () => ({ code: 0, events: roundEvents() }),
    ...deps,
  });
  const until = Date.now() + 3000;
  while (!w.calls.some((c) => c.body?.events?.some?.((e) => e.type === 'finished')) && !deps.stopWhen?.(w.calls) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await d.stop('test');
  return { logs, dirs };
}

describe('daemon exit paths: revoke comes before the last events call', () => {
  it('success: round events, then revoke, then finished{completed} alone', async () => {
    const w = world();
    const { dirs } = await runOne(w);
    assert.deepEqual(sequence(w.calls), ['started+summary', 'revoke', 'finished']);
    const fin = w.calls.findLast((c) => c.body?.events?.[0]?.type === 'finished').body.events[0];
    assert.equal(fin.conclusion, 'completed');
    assert.deepEqual(fin._meta, { token_revoked: true, exit: 'success' });
    assert.equal(w.calls.find((c) => c.path === '/installation/token').auth, `Bearer ${INSTALL_TOKEN}`);
    assert.equal(existsSync(dirs[0]), false);
  });

  it('engine failure: the round\'s own events, revoke, finished{failed}', async () => {
    const w = world();
    await runOne(w, { runRound: async () => ({ code: 3, events: [event('started', {}), event('error', { failure_class: 'rate-limited' }), event('finished', { conclusion: 'failed' })] }) });
    assert.deepEqual(sequence(w.calls), ['started+error', 'revoke', 'finished']);
    const fin = w.calls.findLast((c) => c.body?.events?.[0]?.type === 'finished').body.events[0];
    assert.equal(fin.conclusion, 'failed');
    assert.equal(fin._meta.exit, 'engine-failure');
  });

  it('engine crash with no events.jsonl: a synthesized started+error, revoke, finished{failed}', async () => {
    const w = world();
    await runOne(w, { runRound: async () => ({ code: null, signal: 'SIGSEGV', events: null }) });
    assert.deepEqual(sequence(w.calls), ['started+error', 'revoke', 'finished']);
  });

  it('SIGTERM mid-round: the run is aborted first, then revoke, then finished{cancelled}', async () => {
    const w = world();
    let aborted = false;
    const d = await startDaemon(config(), { containerReady: ready,
      fetch: w.fetch, heartbeatMs: 20, backoffUnitMs: 1, log: () => {}, checkout: async () => {},
      mkTemp: (p) => mkdtempSync(path.join(os.tmpdir(), p)),
      runRound: (job, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve({ code: null, signal: 'SIGTERM', events: null }); });
      }),
    });
    while (!w.calls.some((c) => c.path === '/runner/lease')) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 30));
    await d.stop('SIGTERM');
    assert.equal(aborted, true);
    assert.deepEqual(sequence(w.calls), ['revoke', 'finished']);
    const fin = w.calls.findLast((c) => c.body?.events?.[0]?.type === 'finished').body.events[0];
    assert.equal(fin.conclusion, 'cancelled');
    assert.equal(fin._meta.exit, 'sigterm');
  });

  it('checkout failure: started+error with the token redacted, revoke, finished{failed}; no round runs', async () => {
    const w = world();
    let ran = false;
    const { logs } = await runOne(w, {
      checkout: async () => { throw new Error(`fatal: could not read from https://x-access-token:${INSTALL_TOKEN}@github.com`); },
      runRound: async () => { ran = true; return { code: 0, events: roundEvents() }; },
    });
    assert.equal(ran, false);
    assert.deepEqual(sequence(w.calls), ['started+error', 'revoke', 'finished']);
    const fin = w.calls.findLast((c) => c.body?.events?.[0]?.type === 'finished').body.events[0];
    assert.equal(fin._meta.exit, 'checkout-failed');
    const posted = JSON.stringify(w.calls.map((c) => c.body ?? null));
    assert.doesNotMatch(posted, new RegExp(INSTALL_TOKEN));
    assert.doesNotMatch(posted, new RegExp(KEY));
    assert.doesNotMatch(logs.join('\n'), new RegExp(`${INSTALL_TOKEN}|${KEY}|${RUNNER_TOKEN}`));
  });

  it('lease lost: revoke still runs, no finished is posted, and the slot leases again', async () => {
    const w = world({ jobs: [JOB], eventsStatus: (events) => (events.length ? 409 : 204) });
    await runOne(w, { stopWhen: (calls) => calls.filter((c) => c.path === '/runner/lease').length >= 3 });
    const seq = sequence(w.calls);
    assert.deepEqual(seq, ['started+summary', 'revoke']);
    assert.ok(w.calls.filter((c) => c.path === '/runner/lease').length >= 2);
  });

  it('a failed revoke still posts finished, with token_revoked false', async () => {
    const w = world({ revokeStatus: 500 });
    await runOne(w);
    const fin = w.calls.findLast((c) => c.body?.events?.[0]?.type === 'finished').body.events[0];
    assert.equal(fin._meta.token_revoked, false);
  });

  it('batches 120 events as 100 and 20, and finished still travels alone', async () => {
    const w = world();
    const many = Array.from({ length: 120 }, () => event('read', { path: 'a.js' }));
    await runOne(w, { runRound: async () => ({ code: 0, events: [...many, event('finished', { conclusion: 'completed' })] }) });
    const sizes = w.calls.filter((c) => c.path.startsWith('/runner/jobs/') && c.body.events.length).map((c) => c.body.events.length);
    assert.deepEqual(sizes, [100, 20, 1]);
  });

  it('leases once per slot in parallel when concurrency is 2', async () => {
    const w = world({ jobs: [] });
    const cfg = config(2);
    const d = await startDaemon(cfg, { containerReady: ready, fetch: w.fetch, log: () => {}, backoffUnitMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    await d.stop('test');
    const leases = w.calls.filter((c) => c.path === '/runner/lease');
    assert.ok(leases.length >= 2);
  });

  it('re-registers once on unregistered-credential, then leases again', async () => {
    const w = world({ leaseError: 'unregistered-credential' });
    await runOne(w);
    assert.equal(w.calls.filter((c) => c.path === '/runner/register').length, 2);
    assert.deepEqual(sequence(w.calls), ['started+summary', 'revoke', 'finished']);
  });

  it('a second re-registration after a successful lease does not stop the daemon', async () => {
    const w = world({ jobs: [JOB, { ...JOB, id: '22222222-2222-4222-8222-222222222222' }], leaseErrorAt: (n) => n === 1 || n === 3 });
    const d = await startDaemon(config(), { containerReady: ready, fetch: w.fetch, heartbeatMs: 20, backoffUnitMs: 1, log: () => {}, checkout: async () => {}, runRound: async () => ({ code: 0, events: roundEvents() }) });
    let failed = null;
    d.done.catch((e) => { failed = e; });
    const until = Date.now() + 3000;
    while (w.calls.filter((c) => c.body?.events?.some?.((e) => e.type === 'finished')).length < 2 && !failed && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    await d.stop('test');
    assert.equal(failed, null);
    assert.equal(w.calls.filter((c) => c.path === '/runner/register').length, 3);
    assert.deepEqual(sequence(w.calls), ['started+summary', 'revoke', 'finished', 'started+summary', 'revoke', 'finished']);
  });

  it('back-to-back unregistered-credential with no lease between is fatal', async () => {
    const w = world({ jobs: [], leaseErrorAt: () => true });
    const d = await startDaemon(config(), { containerReady: ready, fetch: w.fetch, backoffUnitMs: 1, log: () => {} });
    await assert.rejects(d.done, /credential unregistered twice/);
  });

  it('an unexpected throw still posts started+error, revokes, posts finished and removes the temp dir', async () => {
    const w = world();
    const { dirs, logs } = await runOne(w, { runRound: async () => { throw new Error(`boom ${INSTALL_TOKEN}`); } });
    assert.deepEqual(sequence(w.calls), ['started+error', 'revoke', 'finished']);
    const fin = w.calls.findLast((c) => c.body?.events?.[0]?.type === 'finished').body.events[0];
    assert.equal(fin.conclusion, 'failed');
    assert.deepEqual(fin._meta, { token_revoked: true, exit: 'runner-error' });
    assert.equal(existsSync(dirs[0]), false);
    assert.doesNotMatch(JSON.stringify(w.calls.map((c) => c.body ?? null)), new RegExp(INSTALL_TOKEN));
    assert.doesNotMatch(logs.join('\n'), new RegExp(INSTALL_TOKEN));
  });

  it('redacts the installation token and the credential from round events before posting them', async () => {
    const w = world();
    await runOne(w, { runRound: async () => ({ code: 3, events: [
      event('started', { engine: 'opencode' }),
      event('error', { failure_class: 'api-error', message: `401 for ${KEY} via ${INSTALL_TOKEN}`, detail: { argv: [`GH_TOKEN=${INSTALL_TOKEN}`] } }),
      event('finished', { conclusion: 'failed' }),
    ] }) });
    const posted = w.calls.find((c) => c.body?.events?.some?.((e) => e.type === 'error')).body.events.find((e) => e.type === 'error');
    assert.equal(posted.message, '401 for [redacted] via [redacted]');
    assert.doesNotMatch(JSON.stringify(w.calls.map((c) => c.body ?? null)), new RegExp(`${INSTALL_TOKEN}|${KEY}`));
  });

  it('never sends the installation token or the key to the control plane', async () => {
    const w = world();
    await runOne(w);
    for (const c of w.calls.filter((x) => x.path.startsWith('/runner/'))) {
      assert.equal(c.auth, `Bearer ${RUNNER_TOKEN}`);
      assert.doesNotMatch(JSON.stringify(c.body ?? {}), new RegExp(`${INSTALL_TOKEN}|${KEY}`));
    }
  });
});

describe('register failures', () => {
  it('a duplicate fingerprint is fatal with a message that names the cause', async () => {
    const fetch = async () => new Response(JSON.stringify({ error: 'duplicate-fingerprint' }), { status: 409 });
    await assert.rejects(startDaemon(config(), { containerReady: ready, fetch, log: () => {} }), /another live runner holds/);
  });
  it('ControlPlaneError carries the status and code', () => {
    const e = new ControlPlaneError(409, 'lease-lost');
    assert.equal(e.status, 409);
    assert.equal(e.code, 'lease-lost');
  });
});

describe('the container gate (#184)', () => {
  it('is closed until the container slice lands', () => {
    assert.equal(containerReady(), false);
  });

  it('with the real gate, startDaemon throws before any register or lease call', async () => {
    const w = world();
    let ran = false;
    await assert.rejects(
      startDaemon(config(), { fetch: w.fetch, log: () => {}, backoffUnitMs: 1, checkout: async () => {}, runRound: async () => { ran = true; return { code: 0, events: roundEvents() }; } }),
      (e) => e.message === CONTAINER_NOT_READY,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(w.calls, []);
    assert.equal(ran, false);
  });

  it('the daemon binary refuses to start and --check exits non-zero, naming the missing runtime', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'assayer-gate-'));
    const file = path.join(dir, 'runner.json');
    writeFileSync(file, JSON.stringify({
      control_plane: 'http://127.0.0.1:9', runner_token: '${ASSAYER_RUNNER_TOKEN}', placement: 'box',
      credentials: [{ name: 'zen', engine: 'opencode', kind: 'keyless', concurrency: 1 }],
    }));
    const bin = fileURLToPath(new URL('../src/daemon.js', import.meta.url));
    const env = { PATH: process.env.PATH, ASSAYER_RUNNER_TOKEN: RUNNER_TOKEN };
    for (const args of [['--config', file, '--check'], ['--config', file]]) {
      const r = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: 10000 });
      assert.notEqual(r.status, 0, args.join(' '));
      assert.match(r.stderr, /container runtime is not built yet \(#184\)/);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
