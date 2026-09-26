#!/usr/bin/env node
// The runner daemon (#184): register with the control plane, lease jobs for each credential,
// check the pull request out with the job's installation token, run one round through run.js,
// post its events, revoke the token, then post `finished`. Revocation comes before the last
// events call on every exit path, and test/daemon.test.js pins that order.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createControlPlane, ControlPlaneError, fitEvent, batches, redact } from './control-plane.js';
import { revokeInstallationToken, checkout as gitCheckout } from './github.js';
import { event, classifyFailure } from './events.js';
import { ENGINES } from './engines.js';
import { renderPrompt, promptHash, laneTokens } from './prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'prompt', 'template.md');
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

// The default round: run.js as a child in its own process group, so a SIGTERM reaches it and
// its engine together.
export function spawnRound(job, { cwd, out, promptPath, promptHashValue, credential, credentialValue, installationToken, signal, laneVersion }) {
  const row = ENGINES[job.engine];
  const args = [path.join(HERE, 'run.js'), '--cwd', cwd, '--prompt', promptPath, '--out', out,
    '--engine', job.engine, '--model', job.model ?? row.defaultModel ?? '', '--stage-manifest',
    '--repo', job.repository, '--pr', String(job.pr_number), '--head-sha', job.head_sha, '--mode', job.mode,
    '--prompt-hash', promptHashValue, '--credential-fingerprint', credential.fingerprint,
    ...(laneVersion ? ['--lane-version', laneVersion] : []),
    ...(credential.env ? ['--credential-env', credential.env] : [])];
  if (!(job.model ?? row.defaultModel)) args.splice(args.indexOf('--model'), 2);
  const env = { GH_TOKEN: installationToken };
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR']) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (credential.env) env[credential.env] = credentialValue;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});
    let killTimer = null;
    const onAbort = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code, sig) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      let events = null;
      try { events = readEvents(out); } catch { events = null; }
      resolve({ code, signal: sig, events });
    });
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
    const out = path.join(dir, 'round');
    const cwd = path.join(dir, 'checkout');
    if (cancelled) {
      conclusion = 'cancelled'; exit = 'sigterm';
    } else if (job.mode === 'incremental') {
      events = [startedEvent(), event('error', { failure_class: 'api-error', retryable: false, message: 'incremental jobs carry no range; unsupported' })];
    } else {
      let checkedOut = false;
      try {
        await ctx.checkout({ repository: job.repository, headSha: job.head_sha, baseSha: job.base_sha, token, dir: cwd });
        checkedOut = true;
      } catch (e) {
        const message = redact(e.message, ctx.secrets);
        events = [startedEvent(), event('error', { failure_class: classifyFailure(message) ?? 'api-error', message })];
        exit = 'checkout-failed';
      }
      if (checkedOut && cancelled) {
        conclusion = 'cancelled'; exit = 'sigterm';
      } else if (checkedOut) {
        mkdirSync(out, { recursive: true });
        const template = readFileSync(TEMPLATE, 'utf8');
        const promptPath = path.join(out, 'prompt.md');
        writeFileSync(promptPath, renderPrompt(template, laneTokens({ repo: job.repository, pr: job.pr_number, level: job.level ?? 'medium', mode: job.mode })));
        const result = await ctx.runRound(job, {
          cwd, out, promptPath, promptHashValue: promptHash(template), credential,
          credentialValue: ctx.config.secrets?.get(credential.name) ?? null,
          installationToken: token, signal: run.signal, laneVersion: ctx.laneVersion ?? null,
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

export async function startDaemon(config, deps = {}) {
  const secrets = new Set([config.runner_token, ...(config.secrets?.values() ?? [])]);
  const write = deps.log ?? ((s) => process.stderr.write(`${s}\n`));
  const log = (msg) => write(`assayer-runner ${new Date().toISOString()} ${redact(msg, secrets)}`);
  const cp = deps.controlPlane ?? createControlPlane({ baseUrl: config.control_plane, token: config.runner_token, fetch: deps.fetch });
  const stop = new AbortController();
  const base = {
    config, cp, log, secrets,
    revoke: deps.revoke ?? ((t) => revokeInstallationToken(t, { fetch: deps.fetch })),
    checkout: deps.checkout ?? gitCheckout,
    runRound: deps.runRound ?? spawnRound,
    mkTemp: deps.mkTemp ?? ((prefix) => mkdtempSync(path.join(os.tmpdir(), prefix))),
    rmDir: deps.rmDir ?? ((d) => rmSync(d, { recursive: true, force: true })),
    sleep: deps.sleep ?? sleep,
    backoffUnitMs: deps.backoffUnitMs ?? 1000,
    heartbeatMs: deps.heartbeatMs,
    laneVersion: deps.laneVersion ?? process.env.ASSAYER_LANE_VERSION ?? null,
    stopSignal: stop.signal,
  };

  let registration;
  const register = async () => {
    try {
      registration = await cp.register({ credentials: config.credentials });
    } catch (e) {
      if (e instanceof ControlPlaneError && e.code === 'duplicate-fingerprint') {
        throw new Error('register: another live runner holds one of these credential fingerprints');
      }
      throw new Error(`register: ${e.message}`);
    }
  };
  await register();
  log(`registered runner ${registration.runner_id}, ${config.credentials.length} credential(s)`);
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
    for (const c of config.credentials) process.stdout.write(`${c.name} ${c.engine} ${c.kind} ${c.fingerprint} ${c.concurrency}\n`);
    process.exit(0);
  }
  startDaemon(config).then((d) => {
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { d.stop(sig).then(() => process.exit(0)); });
    return d.done;
  }).then(() => process.exit(0)).catch((e) => { process.stderr.write(`assayer-runner: ${e.message}\n`); process.exit(1); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
