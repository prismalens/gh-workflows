// The two GitHub calls the daemon makes with a job's installation token: a shallow checkout at
// the job's head, and the revocation that ends every job (#184).
import { spawn as nodeSpawn } from 'node:child_process';

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
export async function checkout({ repository, headSha, baseSha, token, dir, spawn = nodeSpawn, timeoutMs = 120000 }) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
  // Inside the staging container the proxy is the only way to github.com (#184).
  for (const k of ['HTTPS_PROXY', 'https_proxy']) if (process.env[k]) env[k] = process.env[k];
  const shas = baseSha && baseSha !== headSha ? [headSha, baseSha] : [headSha];
  await run(spawn, ['init', '-q', dir], { env, timeoutMs });
  await run(spawn, ['fetch', '-q', '--depth=1', `https://github.com/${repository}.git`, ...shas], { cwd: dir, env, timeoutMs });
  await run(spawn, ['checkout', '-q', '--detach', headSha], { cwd: dir, env, timeoutMs });
}
