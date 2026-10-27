// The two GitHub calls the daemon makes with a job's installation token: a shallow checkout at
// the job's head, and the revocation that ends every job (#184).
import { spawn as nodeSpawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

export const RESERVED = ['.assayer-threads.json', '.assayer-open-threads.json'];

// The value worker/github-app.js sends.
const API_VERSION = '2022-11-28';

// Resolves true on 204 and false on anything else, including a network error. Never throws:
// the job's last event still has to be posted.
export async function revokeInstallationToken(token, { fetch = globalThis.fetch, apiBase = 'https://api.github.com', timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(`${apiBase}/installation/token`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

function run(spawn, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error((stderr.split('\n').find((l) => l.trim()) ?? `git ${args[0]} exited ${code}`).trim()));
    });
  });
}

// The token travels in the environment as an extraheader, never in argv or a URL, so `ps`
// never shows it (actions/checkout's header, set through GIT_CONFIG_* instead of a file).
// Commits a later step needs beside head and base, such as the commit a finding was posted on.
// Best effort: a sha a force-push left unreachable is reported, not fatal.
export async function fetchCommits({ repository, shas, token, dir, spawn = nodeSpawn, timeoutMs = 120000 }) {
  const env = gitEnv(token);
  const missing = [];
  for (const sha of shas) {
    try { await run(spawn, ['fetch', '-q', '--depth=1', `https://github.com/${repository}.git`, sha], { cwd: dir, env, timeoutMs }); } catch { missing.push(sha); }
  }
  return missing;
}

function gitEnv(token) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

export async function checkout({ repository, headSha, baseSha, token, dir, spawn = nodeSpawn, timeoutMs = 120000 }) {
  const env = gitEnv(token);
  const shas = baseSha && baseSha !== headSha ? [headSha, baseSha] : [headSha];
  await run(spawn, ['init', '-q', dir], { env, timeoutMs });
  await run(spawn, ['fetch', '-q', '--depth=1', `https://github.com/${repository}.git`, ...shas], { cwd: dir, env, timeoutMs });
  await run(spawn, ['checkout', '-q', '--detach', headSha], { cwd: dir, env, timeoutMs });
  // These names are the runner's to write. A PR that commits one would steer the round, so
  // every checkout, local or daemon, starts without them.
  for (const f of RESERVED) rmSync(path.join(dir, f), { force: true, recursive: true });
}
