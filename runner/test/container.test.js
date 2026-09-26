import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkContainer, detectRuntime, resolveImage, runArgs, runStep } from '../src/container.js';

const HASH = 'f'.repeat(64);
const ID = `sha256:${'a'.repeat(64)}`;
const KEY = 'sk-configured-secret-value';

// A fake runtime CLI: answer(cmd, args) returns { code, stdout } for each spawn; every spawn is recorded.
function fakeExec(answer, spawns = []) {
  return (cmd, args, opts) => {
    spawns.push({ cmd, args, env: opts?.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', null, 'SIGKILL');
    const r = answer(cmd, args) ?? { code: 0, stdout: '' };
    if (r.hang) return child;
    setImmediate(() => { if (r.stdout) child.stdout.emit('data', r.stdout); child.emit('close', r.code, null); });
    return child;
  };
}

const base = { image: ID, name: 'n', jobDir: '/j', uid: 1000, gid: 1000, memory: '4g', envNames: ['GH_TOKEN'], cmd: ['node', 'x.js'] };

describe('container (#184)', () => {
  it('runArgs isolates the step, and podman differs from docker only by keep-id', () => {
    const docker = runArgs({ ...base, runtime: 'docker', checkoutMode: 'ro' });
    const podman = runArgs({ ...base, runtime: 'podman', checkoutMode: 'ro' });
    assert.deepEqual(podman.filter((a) => a !== '--userns=keep-id'), docker);
    assert.ok(podman.includes('--userns=keep-id'));
    for (const flag of [['--network', 'none'], ['--cap-drop', 'ALL'], ['--user', '1000:1000'], ['--memory', '4g']]) {
      assert.equal(docker[docker.indexOf(flag[0]) + 1], flag[1], flag[0]);
    }
    assert.ok(docker.includes('--read-only'));
    const mounts = docker.flatMap((a, i) => (a === '-v' ? [docker[i + 1]] : []));
    assert.deepEqual(mounts, ['/j/checkout:/checkout:ro', '/j/round:/round:rw', '/j/sock:/run/assayer:rw']);
    assert.deepEqual(docker.flatMap((a, i) => (a === '-e' ? [docker[i + 1]] : [])), ['GH_TOKEN'], 'names only, never values');
    assert.deepEqual(docker.slice(-3), [ID, 'node', 'x.js']);
    assert.throws(() => runArgs({ ...base, runtime: 'docker', checkoutMode: 'rwx' }), /checkout mode/);
  });

  it('detectRuntime takes the config, then podman, then docker, else throws', () => {
    assert.equal(detectRuntime({ container: { runtime: 'docker' } }, { which: () => true }), 'docker');
    assert.equal(detectRuntime({ container: { runtime: null } }, { which: (b) => b === 'podman' }), 'podman');
    assert.equal(detectRuntime({ container: {} }, { which: (b) => b === 'docker' }), 'docker');
    assert.throws(() => detectRuntime({}, { which: () => false }), /no podman or docker/);
  });

  it('resolveImage needs the image and a label equal to the input hash', async () => {
    const ok = fakeExec(() => ({ code: 0, stdout: `${ID}|${HASH}\n` }));
    assert.equal(await resolveImage({ runtime: 'docker', hash: HASH, exec: ok }), ID);
    await assert.rejects(resolveImage({ runtime: 'docker', hash: HASH, exec: fakeExec(() => ({ code: 1 })) }), /missing; run runner\/scripts\/build-image.mjs/);
    await assert.rejects(resolveImage({ runtime: 'docker', hash: HASH, exec: fakeExec(() => ({ code: 0, stdout: `${ID}|${'e'.repeat(64)}` })) }), /other inputs/);
  });

  describe('checkContainer', () => {
    const good = { uid: 1000, checkout_writable: false, docker_sock: false, direct_connect: 'ENETUNREACH', proxy_denied: 403, proxy_allowed: 200, environ: ['HOME=/round/home'] };
    const config = { container: { memory: '4g' }, secrets: new Map([['k', KEY]]) };

    async function check(probe, over = {}) {
      const record = [];
      const dirs = [];
      const spawns = [];
      const exec = fakeExec(() => ({ code: 0, stdout: `${JSON.stringify(probe)}\n` }), spawns);
      const run = checkContainer({
        config, runtime: 'podman', image: ID, exec, uid: 1000, gid: 1000,
        mkTemp: (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; },
        rmDir: (d) => { record.push('rmDir'); rmSync(d, { recursive: true, force: true }); },
        createProxy: async () => { record.push('proxy'); return { setPhase: (p) => record.push(`phase:${p}`), close: async () => { record.push('close'); } }; },
        ...over,
      });
      return { run, record, spawns };
    }

    it('passes a good probe, drops environ from the report, and cleans up', async () => {
      const { run, record, spawns } = await check(good);
      const report = await run;
      assert.equal(report.environ, undefined);
      assert.equal(report.proxy_denied, 403);
      assert.deepEqual(record, ['proxy', 'phase:engine', 'close', 'rmDir']);
      assert.equal(spawns[0].cmd, 'podman');
      assert.ok(spawns[0].args.includes('/opt/assayer/src/probe.js'));
      assert.ok(spawns[0].args.some((a) => a.endsWith(':/checkout:ro')));
    });

    const bad = [
      ['uid 0', { uid: 0 }, /uid is 0/],
      ['a writable checkout', { checkout_writable: true }, /checkout is writable/],
      ['a runtime socket', { docker_sock: true }, /runtime socket/],
      ['direct egress', { direct_connect: 'connected' }, /direct egress/],
      ['a proxy that allows example.com', { proxy_denied: 200 }, /did not refuse/],
      ['a proxy that refuses api.github.com', { proxy_allowed: 403 }, /did not allow/],
      ['a configured key in environ', { environ: [`X=${KEY}`] }, /configured key/],
    ];
    for (const [name, over, pattern] of bad) {
      it(`fails on ${name}, and still closes the proxy and removes the dir`, async () => {
        const { run, record } = await check({ ...good, ...over });
        await assert.rejects(run, pattern);
        assert.deepEqual(record.slice(-2), ['close', 'rmDir']);
      });
    }

    it('fails when the probe prints nothing parseable', async () => {
      const { run, record } = await check(null, { exec: fakeExec(() => ({ code: 125, stdout: 'Error: no such image' })) });
      await assert.rejects(run, /printed no report \(exit 125\)/);
      assert.deepEqual(record.slice(-2), ['close', 'rmDir']);
    });

    it('refuses to run as root before any probe', async () => {
      const { run, record, spawns } = await check(good, { uid: 0 });
      await assert.rejects(run, /must not run as root/);
      assert.deepEqual(record, []);
      assert.deepEqual(spawns, []);
    });
  });

  it('runStep on abort sends TERM, then KILL after the grace, and resolves when the run closes', async () => {
    const spawns = [];
    let runChild = null;
    const exec = (cmd, args, opts) => {
      const r = fakeExec((c, a) => (a[0] === 'run' ? { hang: true } : { code: 0 }), spawns)(cmd, args, opts);
      if (args[0] === 'run') runChild = r;
      if (args[0] === 'kill' && args.includes('KILL')) setImmediate(() => runChild.emit('close', 137, null));
      return r;
    };
    const ac = new AbortController();
    const p = runStep({ runtime: 'docker', args: ['run', 'x'], env: {}, signal: ac.signal, exec, name: 'job-1', killGraceMs: 20 });
    ac.abort();
    const r = await p;
    assert.equal(r.code, 137);
    assert.deepEqual(spawns.map((s) => s.args.join(' ')), ['run x', 'kill --signal TERM job-1', 'kill --signal KILL job-1']);
  });
});
