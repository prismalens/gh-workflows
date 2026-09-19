// A captured ACP session replayed through the mapper must produce the same events the live
// run did. Guards the mapper against the real shape of OpenCode's updates, not a synthetic one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionMapper, readToolLog } from '../src/acp-map.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode-smoke');
const lines = readFileSync(path.join(dir, 'raw.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('opencode smoke session replays to the expected events', () => {
  const m = new SessionMapper({ cwd: '/checkout', engine: 'opencode', model: 'opencode/mimo-v2.5-free' });
  let stops = 0;
  for (const r of lines) {
    if (r.kind === 'update') m.onUpdate(r.notification.update);
    else if (r.kind === 'stop') { m.onStop(r.response); stops += 1; }
  }
  assert.equal(stops, 1);
  const tl = readToolLog(path.join(dir, 'tool-log.jsonl'));
  assert.equal(tl.corrupt, 0);
  const evs = m.finish({ toolLog: tl.entries, wallClockMs: 1 });
  assert.deepEqual(evs.map((e) => e.type), ['started', 'read', 'finding', 'summary', 'usage', 'finished']);
  assert.equal(evs[1].path, 'tools/transcript/README.md');
  assert.equal(evs[2].line, 1); assert.equal(evs[2].body, 'smoke test finding');
  assert.equal(evs[3].header, 'Code review');
  assert.equal(evs[4]._meta.context_used, 12714); assert.equal(evs[4].cost_estimate_usd, 0);
  assert.equal(evs[5].conclusion, 'completed'); assert.equal(evs[5]._meta.tool_calls, 3);
});

test('the fixture carries the update kinds the mapper relies on', () => {
  const kinds = new Set(lines.filter((r) => r.kind === 'update').map((r) => r.notification.update.sessionUpdate));
  for (const k of ['tool_call', 'tool_call_update', 'agent_message_chunk', 'usage_update']) assert.ok(kinds.has(k), k);
});
