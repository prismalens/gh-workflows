#!/usr/bin/env node
// The runner daemon (#184): prove the job container, register with the control plane, lease
// jobs for each credential, stage the pull request and run one round, each in its own container
// behind the key proxy, post the events, revoke the token, then post `finished`. Revocation comes
// before the last events call on every exit path, and test/daemon.test.js pins that order.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createControlPlane, ControlPlaneError, fitEvent, batches, redact } from './control-plane.js';
import { revokeInstallationToken } from './github.js';
import { event, classifyFailure } from './events.js';
import { ENGINES } from './engines.js';
import { renderPrompt, promptHash, laneTokens } from './prompt.js';
import { checkContainer, cliEnv, detectRuntime, jobDirs, resolveImage, runArgs, runStep } from './container.js';
import { createKeyProxy, PROXY_URL } from './key-proxy.js';
import { imageInputHash } from './image-hash.js';
import { STAGE_FAILED } from './stage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = path.join(HERE, '..');
const TEMPLATE = path.join(RUNNER_ROOT, 'prompt', 'template.md');
const RETRY_DELAYS_S = [1, 2, 4, 8, 16];

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function readEvents(out) {
  const file = path.join(out, 'events.jsonl');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function stepName(job, step) {
  return `assayer-${String(job.id).slice(0, 8)}-${step}-${randomBytes(3).toString('hex')}`;
}

// Container step 1: checkout and manifest, /checkout writable, CONNECT to GitHub only.
// A failure throws, and runJob reports it as the checkout-failure path.
export async function containerStage(job, { jobDir, token, signal, container }) {
  const values = { GH_TOKEN: token, ASSAYER_HTTPS_PROXY: PROXY_URL, HOME: '/round/home', LANG: 'C.UTF-8' };
  const name = stepName(job, 'stage');
  const args = runArgs({
    ...container, name, checkoutMode: 'rw', jobDir, envNames: Object.keys(values),
    cmd: ['node', '/opt/assayer/src/stage.js', '--repo', job.repository, '--pr', String(job.pr_number),
      '--head-sha', job.head_sha, ...(job.base_sha ? ['--base-sha', job.base_sha] : []),
      '--mode', job.mode, '--cwd', '/checkout', '--out', '/round'],
  });
  const r = await runStep({ runtime: container.runtime, args, env: cliEnv(values), signal, exec: container.exec, name });
  if (r.code === 0) return;
  let message = `staging exited ${r.code ?? r.signal}`;
  if (r.code === STAGE_FAILED) {
    try { message = readFileSync(path.join(jobDir, 'round', 'stage-error.txt'), 'utf8').trim() || message; } catch { /* keep the exit */ }
  }
  throw new Error(message);
}

// Container step 2: the engine, /checkout read-only, the model reached only through the proxy
// with the round's nonce. No configured key reaches this environment.
export function spawnRound(job, { jobDir, out, promptHashValue, credential, installationToken, proxyToken, signal, laneVersion, container }) {
  const row = ENGINES[job.engine];
  const model = job.model ?? row.defaultModel ?? null;
  const values = {
    GH_TOKEN: installationToken, ASSAYER_HTTPS_PROXY: PROXY_URL, ASSAYER_PROXY_TOKEN: proxyToken,
    HOME: '/round/home', GH_CONFIG_DIR: '/round/home/gh', LANG: 'C.UTF-8', TMPDIR: '/tmp',
  };
  const cmd = ['node', '/opt/assayer/src/run.js', '--cwd', '/checkout', '--prompt', '/round/prompt.md', '--out', '/round',
    '--engine', job.engine, ...(model ? ['--model', model] : []),
    '--repo', job.repository, '--pr', String(job.pr_number), '--head-sha', job.head_sha, '--mode', job.mode,
    '--prompt-hash', promptHashValue, '--credential-fingerprint', credential.fingerprint,
    ...(laneVersion ? ['--lane-version', laneVersion] : []),
    '--proxy-base-url', PROXY_URL, '--staged-json', '/round/staged.json'];
  const name = stepName(job, 'engine');
  const args = runArgs({ ...container, name, checkoutMode: 'ro', jobDir, envNames: Object.keys(values), cmd });
  return runStep({ runtime: container.runtime, args, env: cliEnv(values), signal, exec: container.exec, name })
    .then(({ code, signal: sig }) => {
      let events = null;
      try { events = readEvents(out); } catch { events = null; }
      return { code, signal: sig, events };
    });
}

function exitLabel(conclusion) {
  if (conclusion === 'completed') return 'success';
  if (conclusion === 'cancelled') return 'sigterm';
  return 'engine-failure';
}

// Every string in an event, with the installation token and the configured credentials cut
// out: run.js records raw engine and API error text, and the engine saw both.
export function redactEvent(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactEvent(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactEvent(v, secrets)]));
  }
  return value;
}

// One job, every exit path, an unexpected throw included. Order: [batches of round events] →
// revoke → [finished].
export async function runJob(ctx, lease) {
  const { cp, log, credential } = ctx;
  const job = lease.job;
  const token = lease.installation_token;
  ctx.secrets.add(token);
  ctx.secrets.add(Buffer.from(`x-access-token:${token}`).toString('base64'));
  const started = Date.now();
  const run = new AbortController();
  let leaseLost = false;
  let cancelled = false;
  const onStop = () => { cancelled = true; run.abort('sigterm'); };
  const loseLease = (e) => {
    if (e instanceof ControlPlaneError && (e.status === 409 || e.status === 403)) {
      leaseLost = true;
      run.abort('lease-lost');
      return true;
    }
    return false;
  };
  const startedEvent = () => event('started', { engine: job.engine, model: job.model ?? null, credential_fingerprint: credential.fingerprint });
  let dir = null;
  let proxy = null;
  let heartbeat = null;
  let events = [];
  let conclusion = 'failed';
  let exit = 'engine-failure';
  try {
    if (ctx.stopSignal.aborted) onStop();
    else ctx.stopSignal.addEventListener('abort', onStop, { once: true });
    log(`job ${job.id} ${job.repository}#${job.pr_number} ${job.engine}/${job.credential_kind} attempt ${job.attempt ?? 1}`);
    const beatMs = ctx.heartbeatMs ?? Math.min(60, Math.floor((lease.heartbeat_timeout_s ?? 300) / 5)) * 1000;
    heartbeat = setInterval(() => {
      cp.postEvents(job.id, []).catch((e) => { if (!loseLease(e)) log(`heartbeat: ${e.message}`); });
    }, beatMs);
    dir = ctx.mkTemp('assayer-job-');
    jobDirs(dir);
    const out = path.join(dir, 'round');
    const proxyToken = randomBytes(24).toString('base64url');
    ctx.secrets.add(proxyToken);
    proxy = await ctx.createProxy({
      socketPath: path.join(dir, 'sock', 'proxy.sock'), token: proxyToken,
      upstream: { url: credential.upstream, auth: credential.upstream_auth ?? null, key: ctx.config.secrets?.get(credential.name) ?? null },
      engineConnect: ENGINES[job.engine]?.egress ?? [], log,
    });
    if (cancelled) {
      conclusion = 'cancelled'; exit = 'sigterm';
    } else if (job.mode === 'incremental') {
      events = [startedEvent(), event('error', { failure_class: 'api-error', retryable: false, message: 'incremental jobs carry no range; unsupported' })];
    } else {
      let checkedOut = false;
      try {
        proxy.setPhase('staging');
        await ctx.stage(job, { jobDir: dir, token, signal: run.signal, container: ctx.container });
        checkedOut = true;
      } catch (e) {
        if (cancelled) {
          conclusion = 'cancelled'; exit = 'sigterm';
        } else {
          const message = redact(e.message, ctx.secrets);
          events = [startedEvent(), event('error', { failure_class: classifyFailure(message) ?? 'api-error', message })];
          exit = 'checkout-failed';
        }
      }
      if (!checkedOut) {
        // reported above
      } else if (cancelled) {
        conclusion = 'cancelled'; exit = 'sigterm';
      } else {
        proxy.setPhase('engine');
        const template = readFileSync(TEMPLATE, 'utf8');
        const promptPath = path.join(out, 'prompt.md');
        writeFileSync(promptPath, renderPrompt(template, laneTokens({ repo: job.repository, pr: job.pr_number, level: job.level ?? 'medium', mode: job.mode })));
        const result = await ctx.runRound(job, {
          jobDir: dir, out, promptPath, promptHashValue: promptHash(template), credential,
          installationToken: token, proxyToken, signal: run.signal, laneVersion: ctx.laneVersion ?? null,
          container: ctx.container,
        });
        const finished = result.events?.find((e) => e.type === 'finished');
        if (cancelled) {
          events = (result.events ?? []).filter((e) => e.type !== 'finished');
          conclusion = 'cancelled'; exit = 'sigterm';
        } else if (result.events && finished) {
          events = result.events.filter((e) => e.type !== 'finished');
          conclusion = finished.conclusion ?? 'failed';
          exit = exitLabel(conclusion);
        } else {
          events = [startedEvent(), event('error', { failure_class: 'api-error', message: `run.js exited ${result.code ?? result.signal} without events` })];
        }
      }
    }
  } catch (e) {
    log(`job ${job.id}: ${e.message}`);
    events = [startedEvent(), event('error', { failure_class: 'api-error', message: `runner: ${e.message}` })];
    conclusion = 'failed'; exit = 'runner-error';
  } finally {
    clearInterval(heartbeat);
    ctx.stopSignal.removeEventListener('abort', onStop);
    try { await proxy?.close(); } catch (e) { log(`job ${job.id}: proxy close: ${e.message}`); }
  }

  try {
    if (!leaseLost) {
      for (const batch of batches(events.map((e) => fitEvent(redactEvent(e, ctx.secrets))))) {
        const ok = await postWithRetry(ctx, job.id, batch);
        if (ok === 'lease-lost') { leaseLost = true; break; }
      }
    }
  } catch (e) {
    log(`job ${job.id}: events: ${e.message}`);
  }
  let revoked = false;
  try { revoked = await ctx.revoke(token); } catch (e) { log(`job ${job.id}: revoke: ${e.message}`); }
  if (!leaseLost) {
    try {
      await postWithRetry(ctx, job.id, [event('finished', { conclusion }, { token_revoked: revoked, exit })]);
    } catch (e) {
      log(`job ${job.id}: finished: ${e.message}`);
    }
  }
  try { if (dir) ctx.rmDir(dir); } catch { /* best effort */ }
  ctx.secrets.delete(token);
  log(`job ${job.id} ${leaseLost ? 'lease-lost' : conclusion} in ${Math.round((Date.now() - started) / 1000)}s, token_revoked=${revoked}`);
  return { conclusion, leaseLost, revoked, exit };
}

async function postWithRetry(ctx, jobId, batch) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ctx.cp.postEvents(jobId, batch);
      return 'ok';
    } catch (e) {
      if (!(e instanceof ControlPlaneError)) throw e;
      if (e.status === 409 || e.status === 403) return 'lease-lost';
      if (e.status === 400 || e.status === 413) {
        ctx.log(`bug: events dropped (${e.status} ${e.code}): ${batch.map((b) => b.type).join(',')}`);
        return 'dropped';
      }
      if (e.status === 401) { ctx.fatal = e; return 'dropped'; }
      if (attempt >= RETRY_DELAYS_S.length) { ctx.log(`events dropped after retries: ${e.message}`); return 'dropped'; }
      await ctx.sleep(RETRY_DELAYS_S[attempt] * ctx.backoffUnitMs);
    }
  }
}

// Detect the runtime, resolve this checkout's image and prove the container. Runs before any
// register, on every start; a throw here means no control-plane call is ever made.
export async function prepareContainer(config, deps = {}) {
  const exec = deps.exec ?? spawn;
  const runtime = detectRuntime(config, { which: deps.which });
  const image = await (deps.resolveImage ?? resolveImage)({ runtime, hash: deps.imageHash ?? imageInputHash(RUNNER_ROOT), exec });
  const container = {
    runtime, image, exec, memory: config.container?.memory ?? '4g',
    uid: deps.uid ?? process.getuid(), gid: deps.gid ?? process.getgid(),
  };
  const probe = await (deps.checkContainer ?? checkContainer)({
    config, runtime, image, exec, uid: container.uid, gid: container.gid,
    mkTemp: deps.mkTemp ?? ((prefix) => mkdtempSync(path.join(os.tmpdir(), prefix))),
    rmDir: deps.rmDir ?? ((d) => rmSync(d, { recursive: true, force: true })),
    createProxy: deps.createProxy ?? createKeyProxy,
  });
  return { container, probe };
}

export function createContext(config, deps, container, { log, secrets, cp, stopSignal }) {
  return {
    config, cp, log, secrets, container,
    revoke: deps.revoke ?? ((t) => revokeInstallationToken(t, { fetch: deps.fetch })),
    stage: deps.stage ?? containerStage,
    runRound: deps.runRound ?? spawnRound,
    createProxy: deps.createProxy ?? createKeyProxy,
    mkTemp: deps.mkTemp ?? ((prefix) => mkdtempSync(path.join(os.tmpdir(), prefix))),
    rmDir: deps.rmDir ?? ((d) => rmSync(d, { recursive: true, force: true })),
    sleep: deps.sleep ?? sleep,
    backoffUnitMs: deps.backoffUnitMs ?? 1000,
    heartbeatMs: deps.heartbeatMs,
    laneVersion: deps.laneVersion ?? process.env.ASSAYER_LANE_VERSION ?? null,
    stopSignal,
  };
}

export async function startDaemon(config, deps = {}) {
  const { container } = await prepareContainer(config, deps);
  const secrets = new Set([config.runner_token, ...(config.secrets?.values() ?? [])]);
  const write = deps.log ?? ((s) => process.stderr.write(`${s}\n`));
  const log = (msg) => write(`assayer-runner ${new Date().toISOString()} ${redact(msg, secrets)}`);
  const cp = deps.controlPlane ?? createControlPlane({ baseUrl: config.control_plane, token: config.runner_token, fetch: deps.fetch });
  const stop = new AbortController();
  const base = createContext(config, deps, container, { log, secrets, cp, stopSignal: stop.signal });
  log(`container ${container.runtime} image ${container.image.slice(0, 19)} passed its check`);

  let registration;
  const register = async () => {
    try {
      registration = await cp.register({ placement: config.placement, credentials: config.credentials });
    } catch (e) {
      if (e instanceof ControlPlaneError && e.code === 'duplicate-fingerprint') {
        throw new Error('register: another live runner holds one of these credential fingerprints');
      }
      throw new Error(`register: ${e.message}`);
    }
  };
  await register();
  log(`registered runner ${registration.runner_id}, ${config.credentials.length} credential(s), placement ${config.placement}`);
  let reregistered = false;

  const runSlot = async (credential) => {
    const ctx = { ...base, credential };
    let delay = 1;
    while (!stop.signal.aborted) {
      let lease;
      try {
        lease = await cp.lease({ engine: credential.engine, kind: credential.kind, wait: registration.lease_wait_max_s ?? 20, signal: stop.signal });
        delay = 1;
        reregistered = false;
      } catch (e) {
        if (stop.signal.aborted) break;
        if (e instanceof ControlPlaneError && e.status === 401) throw new Error('lease: runner token refused (401)');
        if (e instanceof ControlPlaneError && e.code === 'unregistered-credential') {
          if (reregistered) throw new Error('lease: credential unregistered twice');
          reregistered = true;
          await register();
          continue;
        }
        log(`lease: ${e.message}; retrying in ${delay}s`);
        await base.sleep(delay * base.backoffUnitMs * (0.8 + Math.random() * 0.4), stop.signal);
        delay = Math.min(60, delay * 2);
        continue;
      }
      if (!lease) continue;
      await runJob(ctx, lease);
      if (ctx.fatal) throw new Error('events: runner token refused (401)');
    }
  };

  const slots = config.credentials.flatMap((c) => Array(c.concurrency).fill(c));
  const done = Promise.all(slots.map(runSlot)).then(() => undefined);
  return {
    done,
    async stop(reason = 'SIGTERM') {
      log(`stopping: ${reason}`);
      stop.abort(reason);
      await done.catch(() => {});
    },
  };
}

function main(argv) {
  const at = argv.indexOf('--config');
  const file = at >= 0 ? argv[at + 1] : './assayer-runner.json';
  let config;
  try { config = loadConfig(file); } catch (e) { process.stderr.write(`assayer-runner: ${e.message}\n`); process.exit(2); }
  if (argv.includes('--check')) {
    process.stdout.write(`placement ${config.placement}\n`);
    for (const c of config.credentials) process.stdout.write(`${c.name} ${c.engine} ${c.kind} ${c.fingerprint} ${c.concurrency}\n`);
    prepareContainer(config).then(({ container, probe }) => {
      process.stdout.write(`runtime ${container.runtime}\nimage ${container.image}\n${JSON.stringify(probe)}\n`);
      process.exit(0);
    }).catch((e) => { process.stderr.write(`assayer-runner: ${e.message}\n`); process.exit(1); });
    return;
  }
  startDaemon(config).then((d) => {
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { d.stop(sig).then(() => process.exit(0)); });
    return d.done;
  }).then(() => process.exit(0)).catch((e) => { process.stderr.write(`assayer-runner: ${e.message}\n`); process.exit(1); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
