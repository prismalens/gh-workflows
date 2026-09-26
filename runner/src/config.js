// The daemon's config file (#184): where the control plane is, which runner token to present,
// its placement (always `box`), and which credentials it offers. Secrets never sit in the file: the
// runner token and every key are named by environment variable and read at load.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import { ENGINES } from './engines.js';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ENV_REF = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const RUNNER_TOKEN = /^asr_[A-Za-z0-9_-]{43}$/;
const DEFERRED_KINDS = new Set(['user-login', 'bedrock', 'vertex', 'foundry']);

const credentialSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,32}$/),
  engine: z.string(),
  kind: z.string(),
  env: z.string().regex(ENV_NAME).optional(),
  upstream: z.string(),
  upstream_auth: z.enum(['x-api-key', 'bearer']).optional(),
  concurrency: z.number().int().min(1).max(16),
}).strict();

const containerSchema = z.object({
  runtime: z.enum(['podman', 'docker']).optional(),
  memory: z.string().regex(/^\d+[kmg]$/).optional(),
}).strict();

const configSchema = z.object({
  control_plane: z.string(),
  runner_token: z.string(),
  placement: z.string(),
  container: containerSchema.optional(),
  credentials: z.array(credentialSchema).min(1).max(16),
}).strict();

function fail(field, message) {
  throw new Error(`${field}: ${message}`);
}

function sha12(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// What the Worker's FINGERPRINT_PATTERN holds: 12 lowercase hex. An api-key's is a hash of the
// key, so the key never leaves the process; a keyless one is stable per host and engine.
export function fingerprint(kind, engine, material, hostname) {
  if (kind === 'api-key') return sha12(material);
  if (kind === 'keyless') return sha12(`keyless\n${engine}\n${hostname}`);
  throw new Error(`no fingerprint for credential kind ${kind}`);
}

// Where the key proxy forwards the engine's model requests (#184, spec §2): an https origin
// with an optional path prefix, loopback http for tests.
function checkUpstream(field, value) {
  let url;
  try { url = new URL(value); } catch { fail(field, 'not a URL'); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail(field, 'must be https');
  if (url.search || url.hash) fail(field, 'carries no query or hash');
  if (value.endsWith('/')) fail(field, 'has no trailing slash');
  return value;
}

function checkControlPlane(value) {
  let url;
  try { url = new URL(value); } catch { fail('control_plane', 'not a URL'); }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail('control_plane', 'must be https');
  if (url.pathname !== '/' || url.search || url.hash || value.endsWith('/')) fail('control_plane', 'must be an origin with no path or trailing slash');
  return value;
}

export function parseConfig(raw, env = process.env, { hostname = os.hostname() } = {}) {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(issue.path.join('.') || 'config', issue.message);
  }
  const cfg = parsed.data;
  const secrets = new Map();

  const ref = ENV_REF.exec(cfg.runner_token);
  if (!ref) fail('runner_token', 'runner_token must be a ${ENV} reference');
  const token = env[ref[1]];
  if (!token) fail('runner_token', `${ref[1]} is not set`);
  if (!RUNNER_TOKEN.test(token)) fail('runner_token', `${ref[1]} is not a runner token`);

  if (cfg.placement !== 'box') fail('placement', `unknown placement ${cfg.placement}`);

  const seenNames = new Set();
  const seenPairs = new Set();
  const credentials = cfg.credentials.map((c, i) => {
    const at = `credentials[${i}]`;
    const row = ENGINES[c.engine];
    if (!row) fail(`${at}.engine`, `unknown engine ${c.engine}`);
    if (DEFERRED_KINDS.has(c.kind)) fail(`${at}.kind`, `${c.kind} is deferred to a later slice`);
    const kinds = c.engine === 'opencode' ? [...row.credentialKinds, 'keyless'] : row.credentialKinds;
    if (!kinds.includes(c.kind)) fail(`${at}.kind`, `${c.engine} does not take ${c.kind}`);
    if (seenNames.has(c.name)) fail(`${at}.name`, `duplicate name ${c.name}`);
    seenNames.add(c.name);
    const pair = `${c.engine}/${c.kind}`;
    if (seenPairs.has(pair)) fail(at, `a second ${pair} credential`);
    seenPairs.add(pair);
    let material = null;
    if (c.kind === 'api-key') {
      if (!c.env) fail(`${at}.env`, 'an api-key credential names its environment variable');
      material = env[c.env];
      if (!material) fail(`${at}.env`, `${c.env} is not set`);
      secrets.set(c.name, material);
      if (!c.upstream_auth) fail(`${at}.upstream_auth`, 'an api-key credential names how the upstream takes it (x-api-key or bearer)');
    } else if (c.env) {
      fail(`${at}.env`, `a ${c.kind} credential carries no key`);
    } else if (c.upstream_auth) {
      fail(`${at}.upstream_auth`, `a ${c.kind} credential carries no upstream_auth`);
    }
    return {
      name: c.name, engine: c.engine, kind: c.kind, env: c.env ?? null, concurrency: c.concurrency,
      upstream: checkUpstream(`${at}.upstream`, c.upstream), upstream_auth: c.upstream_auth ?? null,
      fingerprint: fingerprint(c.kind, c.engine, material, hostname),
    };
  });

  const config = {
    control_plane: checkControlPlane(cfg.control_plane),
    placement: cfg.placement,
    // runtime stays null until the daemon detects one on PATH.
    container: { runtime: cfg.container?.runtime ?? null, memory: cfg.container?.memory ?? '4g' },
    credentials,
  };
  Object.defineProperty(config, 'runner_token', { value: token, enumerable: false });
  Object.defineProperty(config, 'secrets', { value: secrets, enumerable: false });
  config.toJSON = () => ({ control_plane: config.control_plane, placement: config.placement, container: config.container, credentials });
  Object.defineProperty(config, 'toJSON', { enumerable: false });
  return config;
}

export function loadConfig(path, env = process.env, opts = {}) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail('config', `cannot read ${path}: ${e.message}`); }
  return parseConfig(raw, env, opts);
}
