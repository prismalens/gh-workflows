// Every job step runs in a container from the image this checkout describes (#184, spec §2).
// The runtime is driven through its CLI only, never an API socket, so no socket reaches a job.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { imageTag } from './image-hash.js';
import { PROXY_URL } from './key-proxy.js';

// What the runtime CLI itself needs from the daemon's environment; job values are added per step.
const CLI_ENV = ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_CONFIG', 'CONTAINERS_CONF', 'TMPDIR'];
const PROBE_TIMEOUT_MS = 60_000;

const onPath = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;

export function detectRuntime(config, { which = onPath } = {}) {
  if (config.container?.runtime) return config.container.runtime;
  if (which('podman')) return 'podman';
  if (which('docker')) return 'docker';
  throw new Error('container: no podman or docker on PATH');
}

// Collects stdout; resolves { code, stdout } and never rejects.
export function capture(exec, cmd, args, { env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = exec(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: null, stdout: '', error: e.message }); return; }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    const timer = timeoutMs ? setTimeout(() => child.kill?.('SIGKILL'), timeoutMs) : null;
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function resolveImage({ runtime, hash, exec = nodeSpawn }) {
  const tag = imageTag(hash);
  const r = await capture(exec, runtime, ['image', 'inspect', tag, '--format', '{{.Id}}|{{index .Config.Labels "assayer.input_sha256"}}']);
  if (r.code !== 0) throw new Error(`container: image ${tag} is missing; run runner/scripts/build-image.mjs`);
  const [id, label] = r.stdout.trim().split('|');
  if (label !== hash) throw new Error(`container: image ${tag} was built from other inputs; rebuild it`);
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`container: image ${tag} has no usable id`);
  return id;
}

export function runArgs({ runtime, image, name, checkoutMode, jobDir, uid, gid, memory, envNames, cmd }) {
  if (checkoutMode !== 'ro' && checkoutMode !== 'rw') throw new Error(`container: checkout mode ${checkoutMode}`);
  return [
    'run', '--rm', '--name', name, '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '1024', '--memory', memory, '--user', `${uid}:${gid}`,
    ...(runtime === 'podman' ? ['--userns=keep-id'] : []),
    '-v', `${path.join(jobDir, 'checkout')}:/checkout:${checkoutMode}`,
    '-v', `${path.join(jobDir, 'round')}:/round:rw`,
    '-v', `${path.join(jobDir, 'sock')}:/run/assayer:rw`,
    // Names only: values travel in the CLI's environment, so `ps` never shows a token.
    ...envNames.flatMap((n) => ['-e', n]),
    '--workdir', '/checkout', image, ...cmd,
  ];
}

export function cliEnv(values, source = process.env) {
  const env = {};
  for (const k of CLI_ENV) if (source[k] !== undefined) env[k] = source[k];
  return { ...env, ...values };
}

// Runs one step to completion. On abort: TERM, then KILL after the grace, then wait for close.
export function runStep({ runtime, args, env, signal, exec = nodeSpawn, name, killGraceMs = 5000, onStdout }) {
  return new Promise((resolve) => {
    const child = exec(runtime, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => onStdout?.(d));
    child.stderr?.on('data', () => {});
    let killTimer = null;
    const onAbort = () => {
      exec(runtime, ['kill', '--signal', 'TERM', name], { env, stdio: 'ignore' });
      killTimer = setTimeout(() => exec(runtime, ['kill', '--signal', 'KILL', name], { env, stdio: 'ignore' }), killGraceMs);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => {});
    child.on('close', (code, sig) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig });
    });
  });
}

export function jobDirs(jobDir) {
  for (const d of ['checkout', 'round', 'sock', 'round/home']) mkdirSync(path.join(jobDir, d), { recursive: true, mode: 0o700 });
}

// Proves, in a probe container from the resolved image, what the box ruling requires before any
// register (#184): non-root, read-only checkout, no runtime socket, no direct egress, the proxy
// refusing and allowing as its phase says, and no configured secret in the environment.
export async function checkContainer({
  config, runtime, image, exec = nodeSpawn, mkTemp, rmDir, createProxy,
  uid = process.getuid(), gid = process.getgid(),
}) {
  if (uid === 0) throw new Error('container check: the daemon must not run as root');
  const dir = mkTemp('assayer-probe-');
  let proxy = null;
  try {
    jobDirs(dir);
    const token = randomBytes(24).toString('base64url');
    proxy = await createProxy({ socketPath: path.join(dir, 'sock', 'proxy.sock'), token, upstream: null, engineConnect: [] });
    proxy.setPhase('engine');
    const values = { GH_TOKEN: 'probe', ASSAYER_HTTPS_PROXY: PROXY_URL, ASSAYER_PROXY_TOKEN: token, HOME: '/round/home' };
    const name = `assayer-probe-${randomBytes(4).toString('hex')}`;
    const args = runArgs({
      runtime, image, name, checkoutMode: 'ro', jobDir: dir, uid, gid, memory: config.container?.memory ?? '4g',
      envNames: Object.keys(values), cmd: ['node', '/opt/assayer/src/probe.js'],
    });
    const r = await capture(exec, runtime, args, { env: cliEnv(values), timeoutMs: PROBE_TIMEOUT_MS });
    let probe;
    try { probe = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { throw new Error(`container check: the probe printed no report (exit ${r.code})`); }
    const failed = [];
    if (probe.uid === 0) failed.push('uid is 0');
    if (probe.checkout_writable !== false) failed.push('checkout is writable');
    if (probe.docker_sock !== false) failed.push('a runtime socket is present');
    if (probe.direct_connect === 'connected') failed.push('direct egress connected');
    if (probe.proxy_denied !== 403) failed.push(`proxy did not refuse CONNECT (${probe.proxy_denied})`);
    if (probe.proxy_allowed !== 200) failed.push(`proxy did not allow api.github.com (${probe.proxy_allowed})`);
    const environ = Array.isArray(probe.environ) ? probe.environ : [];
    for (const secret of config.secrets?.values() ?? []) {
      if (secret && environ.some((e) => String(e).includes(secret))) { failed.push('a configured key is in the environment'); break; }
    }
    if (failed.length) throw new Error(`container check: ${failed.join('; ')}`);
    const { environ: _omit, ...report } = probe;
    return report;
  } finally {
    await proxy?.close();
    rmDir(dir);
  }
}
