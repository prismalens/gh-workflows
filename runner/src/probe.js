#!/usr/bin/env node
// Runs inside the job image at daemon start and prints what the container check asserts (#184, spec §2).
// It only reports; the daemon decides.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';

function directConnect(host = '1.1.1.1', port = 443, ms = 3000) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, ms);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('connected'); });
    s.once('error', (e) => { clearTimeout(t); resolve(e.code || 'error'); });
  });
}

// curl exits non-zero on a refused CONNECT; %{http_connect} is still on stdout.
function connectStatus(url) {
  const args = ['-sS', '-o', '/dev/null', '-w', '%{http_connect}', '--max-time', '10', '--proxy', process.env.ASSAYER_HTTPS_PROXY ?? '', url];
  try {
    return Number(execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    return Number(String(e.stdout ?? '').trim()) || 0;
  }
}

function checkoutWritable() {
  try {
    writeFileSync('/checkout/.assayer-probe', 'x');
    unlinkSync('/checkout/.assayer-probe');
    return true;
  } catch {
    return false;
  }
}

const report = {
  uid: process.getuid(),
  checkout_writable: checkoutWritable(),
  docker_sock: existsSync('/var/run/docker.sock') || existsSync('/run/podman/podman.sock'),
  direct_connect: await directConnect(),
  proxy_denied: connectStatus('https://example.com/'),
  proxy_allowed: connectStatus('https://api.github.com/'),
  environ: readFileSync('/proc/self/environ', 'utf8').split('\0').filter(Boolean),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
