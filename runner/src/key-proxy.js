// The engine's only way out of its container (#184, spec Q2/Q4). It listens on a unix socket the
// container sees as http://127.0.0.1:8787, accepts the round's nonce as the engine's "key", and
// forwards to one configured upstream with the real key set on the wire. CONNECT is a per-phase allowlist.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';

export const PROXY_PORT = 8787;
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
export const STAGING_CONNECT = Object.freeze(['github.com', 'api.github.com']);
export const ENGINE_CONNECT = Object.freeze(['api.github.com']);
const PHASES = new Set(['closed', 'staging', 'engine']);
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

const HOP_BY_HOP = new Set([
  'authorization', 'x-api-key', 'proxy-authorization', 'proxy-connection', 'connection',
  'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function sameToken(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(headers) {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return headers['x-api-key'];
}

// https is required, except plain http to loopback (tests), as checkControlPlane allows.
export function parseUpstream(url) {
  const u = new URL(url);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new Error(`key proxy: upstream must be https (${u.protocol})`);
  }
  if (u.search || u.hash) throw new Error('key proxy: upstream carries no query or hash');
  return u;
}

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

export async function createKeyProxy({
  socketPath, token, upstream = null, engineConnect = [], log = () => {}, connectTo = net.connect,
}) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('key proxy: token too short');
  const up = upstream?.url ? parseUpstream(upstream.url) : null;
  if (up && upstream.auth && (typeof upstream.key !== 'string' || !upstream.key)) {
    throw new Error(`key proxy: upstream auth ${upstream.auth} needs a key`);
  }
  const connectSets = {
    closed: new Set(),
    staging: new Set(STAGING_CONNECT),
    engine: new Set([...ENGINE_CONNECT, ...engineConnect]),
  };
  let phase = 'closed';
  const sockets = new Set();
  const stats = { forwarded: 0, connects: 0, refused: 0 };

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const done = (status) => log(`proxy ${phase} ${req.method} ${req.url?.split('?')[0]} → ${status} ${Date.now() - started}ms`);
    const refuse = (status) => {
      stats.refused += 1;
      res.writeHead(status, { 'content-type': 'text/plain' }).end(`${status}\n`);
      done(status);
    };
    if (phase !== 'engine' || !up) return refuse(403);
    if (!req.url || !req.url.startsWith('/')) return refuse(403); // absolute-form selects another host
    if (!sameToken(presentedToken(req.headers), token)) return refuse(401);

    const headers = filterHeaders(req.headers);
    headers.host = up.host;
    if (upstream.auth === 'x-api-key') headers['x-api-key'] = upstream.key;
    else if (upstream.auth === 'bearer') headers.authorization = `Bearer ${upstream.key}`;
    const basePath = up.pathname.replace(/\/$/, '');
    const upReq = (up.protocol === 'https:' ? https : http).request({
      protocol: up.protocol, hostname: up.hostname, port: up.port || undefined,
      method: req.method, path: `${basePath}${req.url}`, headers,
    });
    // Bounds the wait for response headers only; an SSE body may idle as long as it likes.
    const connectTimer = setTimeout(() => upReq.destroy(new Error('upstream timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);
    upReq.on('socket', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
    upReq.on('response', (upRes) => {
      clearTimeout(connectTimer);
      stats.forwarded += 1;
      res.writeHead(upRes.statusCode ?? 502, filterHeaders(upRes.headers));
      upRes.pipe(res);
      upRes.on('end', () => done(upRes.statusCode));
    });
    upReq.on('error', () => {
      clearTimeout(connectTimer);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('502\n');
      else res.destroy();
      done(502);
    });
    req.pipe(upReq);
  });

  server.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });

  server.on('connect', (req, client, head) => {
    const [host, portText] = String(req.url || '').split(':');
    const allowed = portText === '443' && connectSets[phase].has(host);
    log(`proxy ${phase} CONNECT ${host}:${portText} → ${allowed ? 200 : 403}`);
    if (!allowed) {
      stats.refused += 1;
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    stats.connects += 1;
    const target = connectTo(443, host);
    sockets.add(target);
    target.once('close', () => sockets.delete(target));
    target.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) target.write(head);
      target.pipe(client);
      client.pipe(target);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
  });

  rmSync(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, resolve);
  });

  let closed = null;
  return {
    stats,
    get phase() { return phase; },
    setPhase(next) {
      if (!PHASES.has(next)) throw new Error(`key proxy: unknown phase ${next}`);
      phase = next;
    },
    close() {
      if (closed) return closed;
      phase = 'closed';
      closed = new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }).then(() => rmSync(socketPath, { force: true }));
      return closed;
    },
  };
}
