import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { createKeyProxy } from '../src/key-proxy.js';

const TOKEN = 'round-nonce-0123456789abcdef';
const KEY = 'sk-real-upstream-key-XYZ';

// A local upstream that records every request it sees; /sse streams three chunks 50 ms apart.
function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url.endsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      let n = 0;
      const t = setInterval(() => {
        res.write(`data: ${n}\n\n`);
        if (++n === 3) { clearInterval(t); setTimeout(() => res.end(), 50); }
      }, 50);
      req.on('close', () => clearInterval(t));
      return;
    }
    if (req.url.endsWith('/hang')) return; // never answers
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` });
  }));
}

function request(socketPath, { method = 'GET', target = '/messages', headers = {}, onData } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: target, headers });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push({ at: Date.now(), text: c.toString() }); onData?.(c.toString()); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks, body: chunks.map((c) => c.text).join('') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(socketPath, target) {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); s.destroy(); });
  });
}

// A fake connect target: emits 'connect' so no real network is touched.
function fakeConnect(calls) {
  return (port, host) => {
    calls.push(`${host}:${port}`);
    const s = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    setImmediate(() => s.emit('connect'));
    return s;
  };
}

describe('key proxy (#184)', () => {
  let upstream; let dir;
  before(async () => { upstream = await startUpstream(); dir = mkdtempSync(path.join(tmpdir(), 'kp-')); });
  after(() => upstream.server.close());

  let n = 0;
  async function proxy(opts = {}) {
    const socketPath = path.join(dir, `p${n++}.sock`);
    const logs = [];
    const p = await createKeyProxy({
      socketPath, token: TOKEN, upstream: { url: upstream.url, auth: 'x-api-key', key: KEY },
      log: (l) => logs.push(l), ...opts,
    });
    return { p, socketPath, logs };
  }

  it('accepts the nonce as x-api-key or Bearer; a wrong, missing or other-length token gets 401 and no upstream call', async () => {
    const { p, socketPath } = await proxy();
    p.setPhase('engine');
    assert.equal((await request(socketPath, { headers: { 'x-api-key': TOKEN } })).status, 200);
    assert.equal((await request(socketPath, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
    const before = upstream.seen.length;
    for (const headers of [{ 'x-api-key': TOKEN.replace(/.$/, 'X') }, {}, { 'x-api-key': 'short' }, { authorization: `Basic ${TOKEN}` }]) {
      assert.equal((await request(socketPath, { headers })).status, 401, JSON.stringify(headers));
    }
    assert.equal(upstream.seen.length, before);
    await p.close();
  });

  it('sets the upstream auth header per credential and never forwards the incoming one', async () => {
    for (const [auth, check] of [
      ['x-api-key', (h) => h['x-api-key'] === KEY && h.authorization === undefined],
      ['bearer', (h) => h.authorization === `Bearer ${KEY}` && h['x-api-key'] === undefined],
      [null, (h) => h.authorization === undefined && h['x-api-key'] === undefined],
    ]) {
      const { p, socketPath } = await proxy({ upstream: { url: upstream.url, auth, key: auth ? KEY : null } });
      p.setPhase('engine');
      await request(socketPath, { method: 'POST', target: '/messages?beta=true', headers: { authorization: `Bearer ${TOKEN}`, 'anthropic-version': '2023-06-01' } });
      const got = upstream.seen.at(-1);
      assert.ok(check(got.headers), `${auth}: ${JSON.stringify(got.headers)}`);
      assert.equal(got.url, '/v1/messages?beta=true');
      assert.equal(got.headers['anthropic-version'], '2023-06-01');
      assert.ok(!JSON.stringify(got.headers).includes(TOKEN), 'the nonce never reaches the upstream');
      await p.close();
    }
  });

  it('streams SSE as it arrives', async () => {
    const { p, socketPath } = await proxy();
    p.setPhase('engine');
    const res = await request(socketPath, { target: '/sse', headers: { 'x-api-key': TOKEN } });
    assert.equal(res.body, 'data: 0\n\ndata: 1\n\ndata: 2\n\n');
    assert.ok(res.chunks.length >= 2, 'more than one chunk');
    assert.ok(res.chunks.at(-1).at - res.chunks[0].at >= 80, 'the first chunk arrived before the upstream finished');
    await p.close();
  });

  it('keeps CONNECT to each phase\'s hosts on port 443, and forwards only in engine', async () => {
    const calls = [];
    const { p, socketPath } = await proxy({ connectTo: fakeConnect(calls), engineConnect: ['models.dev'] });
    assert.match(await connect(socketPath, 'api.github.com:443'), / 403 /, 'closed refuses CONNECT');
    assert.equal((await request(socketPath, { headers: { 'x-api-key': TOKEN } })).status, 403, 'closed refuses forwards');

    p.setPhase('staging');
    assert.match(await connect(socketPath, 'github.com:443'), / 200 /);
    assert.match(await connect(socketPath, 'api.github.com:443'), / 200 /);
    for (const t of ['example.com:443', 'api.github.com:80', 'models.dev:443']) assert.match(await connect(socketPath, t), / 403 /, t);
    assert.equal((await request(socketPath, { headers: { 'x-api-key': TOKEN } })).status, 403, 'staging refuses forwards');

    p.setPhase('engine');
    assert.match(await connect(socketPath, 'api.github.com:443'), / 200 /);
    assert.match(await connect(socketPath, 'models.dev:443'), / 200 /);
    assert.match(await connect(socketPath, 'github.com:443'), / 403 /);
    assert.deepEqual(calls, ['github.com:443', 'api.github.com:443', 'api.github.com:443', 'models.dev:443']);
    await p.close();
  });

  it('refuses an absolute-form request target without calling the upstream', async () => {
    const { p, socketPath } = await proxy();
    p.setPhase('engine');
    const before = upstream.seen.length;
    const res = await request(socketPath, { target: 'http://evil.example/v1/messages', headers: { 'x-api-key': TOKEN } });
    assert.equal(res.status, 403);
    assert.equal(upstream.seen.length, before);
    await p.close();
  });

  it('close() ends an in-flight stream, removes the socket, and is idempotent', async () => {
    const { p, socketPath } = await proxy();
    p.setPhase('engine');
    let resolveFirst;
    const first = new Promise((r) => { resolveFirst = r; });
    const inflight = request(socketPath, { target: '/sse', headers: { 'x-api-key': TOKEN }, onData: () => resolveFirst() })
      .then(() => 'ended', () => 'errored');
    await first;
    await p.close();
    assert.ok(['ended', 'errored'].includes(await inflight));
    assert.equal(existsSync(socketPath), false);
    await p.close();
  });

  it('never writes the key to a log line, a response header or a body', async () => {
    const { p, socketPath, logs } = await proxy();
    p.setPhase('engine');
    const ok = await request(socketPath, { headers: { 'x-api-key': TOKEN } });
    const bad = await request(socketPath, { headers: { 'x-api-key': 'nope-nope-nope-nope-nope' } });
    const all = JSON.stringify([logs, ok.headers, ok.body, bad.headers, bad.body]);
    assert.ok(!all.includes(KEY));
    assert.ok(!all.includes(TOKEN));
    assert.ok(logs.length >= 2);
    await p.close();
  });

  it('refuses an auth mode with no key', async () => {
    await assert.rejects(
      createKeyProxy({ socketPath: path.join(dir, 'nokey.sock'), token: TOKEN, upstream: { url: upstream.url, auth: 'bearer', key: null } }),
      /needs a key/,
    );
  });

  it('refuses a non-https upstream other than loopback', async () => {
    await assert.rejects(
      createKeyProxy({ socketPath: path.join(dir, 'bad.sock'), token: TOKEN, upstream: { url: 'http://api.anthropic.com', auth: 'x-api-key', key: KEY } }),
      /must be https/,
    );
  });
});
