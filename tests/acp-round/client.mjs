// A zero-dependency ACP client: initialize, session/new, one prompt, approving every
// permission request. Proves an engine's adapter round against aimock (#250).
//   node client.mjs <prompt> -- <adapter command...>
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const sep = process.argv.indexOf('--');
const prompt = process.argv[2];
const [cmd, ...args] = process.argv.slice(sep + 1);
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 1;
let text = '';
const tools = new Map();

const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject, method });
  send({ id, method, params });
});

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  } else if (msg.method === 'session/request_permission') {
    const allow = msg.params.options.find((o) => o.kind?.startsWith('allow')) ?? msg.params.options[0];
    console.error(`permission: ${msg.params.toolCall?.title ?? '?'} -> ${allow.optionId}`);
    send({ id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
  } else if (msg.method === 'session/update') {
    const u = msg.params.update;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text;
    if (u.sessionUpdate === 'tool_call') console.error(`tool_call: ${u.title ?? u.toolCallId}`);
    if (u.sessionUpdate.startsWith('tool_call') && u.status) tools.set(u.toolCallId, u.status);
    if (u.status === 'failed') console.error(`tool failed: ${JSON.stringify(u).slice(0, 600)}`);
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, error: { code: -32601, message: `client does not handle ${msg.method}` } });
  }
});

const timer = setTimeout(() => { console.error('timed out'); process.exit(3); }, 180_000);
try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  console.error(`initialize: protocolVersion ${init.protocolVersion}`);
  const { sessionId } = await request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const res = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
  console.error(`stopReason: ${res.stopReason}`);
  console.log(text);
  clearTimeout(timer);
  child.kill();
  const statuses = [...tools.values()];
  console.error(`tool calls: ${statuses.join(', ') || 'none'}`);
  const ok = res.stopReason === 'end_turn' && statuses.length > 0 && statuses.every((s) => s === 'completed');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(e.message);
  child.kill();
  process.exit(1);
}
