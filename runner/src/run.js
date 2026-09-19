#!/usr/bin/env node
// One review round over ACP: spawn the engine, open a session on the checkout with the
// lane's comment tools as MCP servers, send the prompt, answer permissions from the lane's
// allowlist, and write raw.jsonl (every ACP message), tool-log.jsonl (every comment tool
// call), events.jsonl (assayer/v1) and summary.json (turns, usage, wall clock) to --out.
// Exit code: 0 completed, 3 engine error, 4 timed out, 2 usage.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, copyFileSync, chmodSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { SessionMapper, readToolLog } from './acp-map.js';
import { decide, chooseOption } from './policy.js';
import { ENGINES, engineEnv } from './engines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { engine: 'opencode', model: null, timeoutMs: 20 * 60 * 1000, idleMs: 8 * 60 * 1000, laneVersion: null, promptHash: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const v = argv[i + 1];
    const need = () => { if (v === undefined) throw new Error(`${a} needs a value`); i += 1; return v; };
    if (a === '--engine') o.engine = need();
    else if (a === '--model') o.model = need();
    else if (a === '--cwd') o.cwd = need();
    else if (a === '--prompt') o.prompt = need();
    else if (a === '--out') o.out = need();
    else if (a === '--timeout-min') o.timeoutMs = Number(need()) * 60 * 1000;
    else if (a === '--idle-min') o.idleMs = Number(need()) * 60 * 1000;
    else if (a === '--lane-version') o.laneVersion = need();
    else if (a === '--prompt-hash') o.promptHash = need();
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['cwd', 'prompt', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
  if (!(o.engine in ENGINES)) throw new Error(`unknown engine ${o.engine}; known: ${Object.keys(ENGINES).join(', ')}`);
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) throw new Error('--timeout-min must be a positive number');
  if (!Number.isFinite(o.idleMs) || o.idleMs <= 0) throw new Error('--idle-min must be a positive number');
  return o;
}

export function whichGh(pathVar) {
  for (const dir of String(pathVar).split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, 'gh');
    try { accessSync(cand, constants.X_OK); if (!statSync(cand).isDirectory()) return cand; } catch { /* next */ }
  }
  return null;
}

function mcpServer(name, toolLog) {
  return { name, command: process.execPath, args: [path.join(HERE, 'finding-tools.js'), name], env: [{ name: 'ASSAYER_TOOL_LOG', value: toolLog }] };
}

export async function runRound(opts, { log = (s) => process.stderr.write(s + '\n') } = {}) {
  const cwd = path.resolve(opts.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`--cwd ${cwd} is not a directory`);
  if (!existsSync(path.join(cwd, '.git'))) throw new Error(`--cwd ${cwd} is not a git checkout`);
  const promptText = readFileSync(opts.prompt, 'utf8');
  if (!promptText.trim()) throw new Error(`--prompt ${opts.prompt} is empty`);
  if (/@@[A-Z_]+@@/.test(promptText)) throw new Error('--prompt still carries @@TOKEN@@ placeholders; render it first');
  const out = path.resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const rawPath = path.join(out, 'raw.jsonl');
  const toolLog = path.join(out, 'tool-log.jsonl');
  const stderrPath = path.join(out, 'engine-stderr.log');
  for (const f of [rawPath, toolLog, stderrPath]) writeFileSync(f, ''); // fresh per run, never appended across runs

  const row = ENGINES[opts.engine];
  if (!opts.model && row.defaultModel) opts.model = row.defaultModel;
  const baseEnv = engineEnv(row);
  // The engine's `gh` is the shim: `pr comment` is recorded, never posted. Story: #184 day one.
  const realGh = whichGh(baseEnv.PATH ?? process.env.PATH ?? '');
  if (!realGh) throw new Error('gh is not on PATH; the lane\'s prompt needs it for read commands');
  const binDir = path.join(out, 'bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(path.join(HERE, 'gh-shim.sh'), path.join(binDir, 'gh'));
  chmodSync(path.join(binDir, 'gh'), 0o755);
  const env = row.prepare({ model: opts.model, outDir: out, env: {
    ...baseEnv, PATH: `${binDir}${path.delimiter}${baseEnv.PATH ?? process.env.PATH ?? ''}`,
    ASSAYER_TOOL_LOG: toolLog, ASSAYER_REAL_GH: realGh,
  } });
  const child = spawn(row.command, row.args({ cwd }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => appendFileSync(stderrPath, d));
  let childExit = null;
  child.on('exit', (code, signal) => { childExit = { code, signal }; });
  child.on('error', (e) => { childExit = { code: null, signal: null, spawnError: e.message }; });

  const mapper = new SessionMapper({ cwd, engine: opts.engine, model: opts.model, promptHash: opts.promptHash, laneVersion: opts.laneVersion });
  const raw = (kind, payload) => appendFileSync(rawPath, JSON.stringify({ at: new Date().toISOString(), kind, ...payload }) + '\n');
  const started = Date.now();
  let conclusion = null; let permissions = { allowed: 0, rejected: 0 };
  let timer = null; let idle = null; let timedOut = false;

  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const app = acp.client({ name: 'assayer-runner' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const { toolCall, options } = ctx.params;
      const d = decide(toolCall);
      const optionId = chooseOption(options || [], d.allow);
      raw('permission', { toolCall, options, decision: d, optionId });
      if (optionId === null) return { outcome: { outcome: 'cancelled' } }; // agent offered no once-only option
      permissions[d.allow ? 'allowed' : 'rejected'] += 1;
      return { outcome: { outcome: 'selected', optionId } };
    });

  try {
    await app.connectWith(stream, async (ctx) => {
      // Two clocks. The wall clock bounds the round; the idle clock cuts an engine whose
      // subagent went quiet (a free model sat 15 minutes on one task on 2026-09-19). Either
      // one cancels the session, then kills the engine if it does not stop on its own.
      const cancel = (why) => {
        if (timedOut) return;
        timedOut = why;
        raw('timeout', { why, sessionId: mapper.sessionId ?? null });
        try { ctx.notify?.(acp.methods.agent.session.cancel, { sessionId: mapper.sessionId }); } catch { /* fall through to kill */ }
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      };
      timer = setTimeout(() => cancel('wall-clock'), opts.timeoutMs);
      idle = setTimeout(() => cancel('idle'), opts.idleMs);
      const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      raw('initialize', { result: init });
      mapper.events[0]._meta = { agent: init.agentInfo ?? null, protocol: init.protocolVersion };
      if (Array.isArray(init.authMethods) && init.authMethods.length && init._meta?.authenticated === false) {
        throw Object.assign(new Error('agent requires authentication: ' + init.authMethods.map((m) => m.id).join(', ')), { stage: 'initialize' });
      }
      return ctx.buildSession(cwd)
        .withMcpServer(mcpServer('github_inline_comment', toolLog))
        .withMcpServer(mcpServer('github_comment', toolLog))
        .withSession(async (session) => {
          mapper.sessionId = session.sessionId;
          raw('session', { sessionId: session.sessionId });
          const p = session.prompt(promptText);
          p.catch(() => {}); // surfaced through nextUpdate's stop or thrown below
          for (;;) {
            const m = await session.nextUpdate();
            if (m.kind === 'stop') { raw('stop', { response: m.response }); mapper.onStop(m.response); return m.response; }
            const n = m.notification ?? m.update ?? m;
            raw('update', { notification: n });
            clearTimeout(idle); idle = setTimeout(() => cancel('idle'), opts.idleMs);
            mapper.onUpdate(n.update ?? n);
          }
        });
    });
  } catch (err) {
    if (timedOut) conclusion = 'timed-out';
    else mapper.onError(err, err?.stage ?? 'prompt');
  } finally {
    clearTimeout(timer); clearTimeout(idle);
    if (childExit === null) child.kill('SIGTERM');
  }
  if (timedOut) conclusion = 'timed-out';
  else if (childExit && (childExit.spawnError || (childExit.code !== 0 && childExit.code !== null)) && !mapper.errored && mapper.stopReason === null) {
    mapper.onError(new Error(childExit.spawnError ?? `engine exited with code ${childExit.code} before the turn ended`), 'engine');
  }

  const tl = readToolLog(toolLog);
  const wallClockMs = Date.now() - started;
  const events = mapper.finish({ toolLog: tl.entries, wallClockMs, conclusion });
  writeFileSync(path.join(out, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const summary = {
    engine: opts.engine, model: opts.model, cwd, conclusion: events.at(-1).conclusion, stop_reason: mapper.stopReason,
    turns: 1, tool_calls: mapper.toolCallCount, reads: mapper.readPaths.size,
    findings: events.filter((e) => e.type === 'finding').length, summary: events.some((e) => e.type === 'summary'),
    permissions, usage: events.find((e) => e.type === 'usage') ?? null, errors: events.filter((e) => e.type === 'error'),
    tool_log_corrupt_lines: tl.corrupt, dropped: mapper.dropped, wall_clock_ms: wallClockMs, engine_exit: childExit,
    timed_out_by: timedOut || null,
  };
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  log(`assayer-run: ${summary.conclusion} in ${Math.round(wallClockMs / 1000)}s, ${summary.tool_calls} tool calls, ${summary.reads} reads, ${summary.findings} findings, summary=${summary.summary}`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`assayer-run: ${e.message}\n`); process.exit(2); }
  runRound(opts).then((s) => process.exit(s.conclusion === 'completed' ? 0 : s.conclusion === 'timed-out' ? 4 : 3))
    .catch((e) => { process.stderr.write(`assayer-run: ${e.message}\n`); process.exit(2); });
}
