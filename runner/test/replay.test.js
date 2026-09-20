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

test('the sreforge#183 round replays: manifest and diff read, four subagents, text summary, tokens', () => {
  const d = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode-sreforge-183');
  const rows = readFileSync(path.join(d, 'raw.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const m = new SessionMapper({ cwd: '/checkout', engine: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', promptHash: 'e775e965', laneVersion: '1b1c597' });
  for (const r of rows) { if (r.kind === 'update') m.onUpdate(r.notification.update); else if (r.kind === 'stop') m.onStop(r.response); }
  const evs = m.finish({ toolLog: readToolLog(path.join(d, 'tool-log.jsonl')).entries });
  assert.deepEqual(evs.filter((e) => e.type === 'read').map((e) => e.path), ['.claude-review-manifest.json', '.claude-review.diff']);
  const agents = evs.filter((e) => e.type === 'agent');
  assert.equal(agents.length, 6);
  assert.ok(agents.every((a) => a._meta.status === 'completed'), 'every subagent finished');
  assert.deepEqual(agents.map((a) => a._meta.subagent_type).sort(), ['explore', 'general', 'general', 'general', 'general', 'general']);
  const s = evs.find((e) => e.type === 'summary');
  assert.equal(s._meta.source, 'agent_text'); assert.match(s.body, /^## Code review/);
  assert.equal(evs.filter((e) => e.type === 'finding').length, 0);
  const u = evs.find((e) => e.type === 'usage'); assert.equal(u.input, 2273); assert.equal(u.output, 362);
  assert.equal(evs.at(-1).conclusion, 'completed');
  assert.equal(rows.filter((r) => r.kind === 'permission').length, 1);
});
