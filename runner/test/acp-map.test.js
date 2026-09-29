import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionMapper, readToolLog, headerOf, looksLikeSecret, selectedModel } from '../src/acp-map.js';

const cwd = '/repo';
const mk = () => new SessionMapper({ cwd, engine: 'opencode', model: 'm', promptHash: 'h', laneVersion: 'v' });
const types = (evs) => evs.map((e) => e.type);

test('reads: one per path, partial updates merge, outside paths flagged, bad locations skipped', () => {
  const m = mk();
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: 'Read' }); // no locations yet
  m.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', locations: [{ path: 'src/a.js', line: 3 }] });
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'read', locations: [{ path: '/repo/src/a.js' }] }); // same file, absolute
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't3', kind: 'read', locations: [{ path: '/etc/passwd' }, { path: '' }, null, { nope: 1 }] });
  m.onUpdate({ sessionUpdate: 'tool_call_update', kind: 'read', locations: [{ path: 'x' }] }); // no id: dropped
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't4', kind: 'execute', title: 'git status', locations: [{ path: '/repo' }, { path: 'src/z.js' }] }); // a command is not a read
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't5', kind: 'read', title: 'ls', locations: [{ path: '/repo' }] }); // the root itself is not a file
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't6', kind: 'search', title: 'glob', locations: [{ path: 'docs/' }] });
  m.onStop({ stopReason: 'end_turn' });
  const evs = m.finish();
  const reads = evs.filter((e) => e.type === 'read');
  assert.deepEqual(reads.map((r) => r.path), ['src/a.js', '/etc/passwd', 'docs']);
  assert.equal(reads[1]._meta.outside_checkout, true);
  assert.equal(evs.at(-1).conclusion, 'completed');
  assert.equal(evs.at(-1)._meta.dropped.length, 1);
  assert.equal(evs.at(-1)._meta.tool_calls, 6);
});

test('findings and summary come from the tool log only; last summary wins; bad entries dropped', () => {
  const m = mk();
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'f', kind: 'other', name: 'mcp__github_inline_comment__create_inline_comment',
    rawInput: { path: 'narrated.js', body: 'not real' } }); // narrated, never recorded: not a finding
  m.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignored when a summary tool call exists' } });
  m.onStop({ stopReason: 'end_turn' });
  const evs = m.finish({ toolLog: [
    { tool: 'create_inline_comment', input: { path: 'src/a.js', body: 'Bug', line: 10, startLine: 8, side: 'LEFT' } },
    { tool: 'create_inline_comment', input: { path: 'src/b.js', body: '   ' } },
    { tool: 'create_inline_comment', input: { path: '../../etc/x', body: 'escape' } },
    { tool: 'create_inline_comment', input: { body: 'no path' } },
    { tool: 'update_claude_comment', input: { body: '## Code review\nfirst' } },
    { tool: 'update_claude_comment', input: { body: '' } },
    { tool: 'update_claude_comment', input: { body: '## Code review\nfinal' } },
    { tool: 'something_else', input: {} },
  ] });
  const f = evs.filter((e) => e.type === 'finding');
  assert.equal(f.length, 2);
  assert.deepEqual([f[0].path, f[0].line, f[0].side, f[0]._meta.start_line], ['src/a.js', 10, 'LEFT', 8]);
  assert.equal(f[1]._meta.path_outside_checkout, true);
  const s = evs.filter((e) => e.type === 'summary');
  assert.equal(s.length, 1); assert.equal(s[0].body, '## Code review\nfinal'); assert.equal(s[0].header, 'Code review');
  assert.equal(s[0]._meta.writes, 3);
  assert.equal(evs.at(-1)._meta.dropped.length, 4);
});

test('no summary tool call falls back to the agent text; no text means no summary event', () => {
  const a = mk(); a.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looks ' } });
  a.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fine.' } });
  a.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image' } });
  a.onStop({ stopReason: 'end_turn' });
  const s = a.finish().find((e) => e.type === 'summary');
  assert.equal(s.body, 'Looks fine.'); assert.equal(s._meta.source, 'agent_text'); assert.equal(s.header, null);
  const b = mk(); b.onStop({ stopReason: 'end_turn' });
  assert.ok(!b.finish().some((e) => e.type === 'summary'));
});

test('stop reasons map to conclusions; errors win; unknown stop reason fails', () => {
  const cases = { end_turn: 'completed', max_tokens: 'truncated', max_turn_requests: 'truncated', refusal: 'refused', cancelled: 'cancelled', weird: 'failed' };
  for (const [r, c] of Object.entries(cases)) { const m = mk(); m.onStop({ stopReason: r }); assert.equal(m.finish().at(-1).conclusion, c, r); }
  const n = mk(); assert.equal(n.finish().at(-1).conclusion, 'failed', 'never stopped');
  const e = mk(); e.onStop({ stopReason: 'end_turn' }); e.onError(new Error('HTTP 429 rate limit. Resets in 3m'), 'prompt');
  const evs = e.finish();
  assert.deepEqual(types(evs).slice(-2), ['error', 'finished']);
  assert.equal(evs.at(-2).failure_class, 'rate-limited'); assert.equal(evs.at(-2).reset_at, '3m'); assert.equal(evs.at(-2)._meta.stage, 'prompt');
  assert.equal(evs.at(-1).conclusion, 'failed');
  const t = mk(); t.onStop({ stopReason: 'cancelled' }); assert.equal(t.finish({ conclusion: 'timed-out' }).at(-1).conclusion, 'timed-out');
  assert.throws(() => mk().finish({ conclusion: 'nope' }));
});

test('usage: last observation wins, non-USD cost is not reported as USD, absent usage emits nothing', () => {
  const m = mk();
  m.onUpdate({ sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.01, currency: 'USD' } });
  m.onUpdate({ sessionUpdate: 'usage_update', used: 500, size: 1000, cost: { amount: 0.05, currency: 'USD' } });
  m.onStop({ stopReason: 'end_turn' });
  const u = m.finish().find((e) => e.type === 'usage');
  assert.equal(u.cost_estimate_usd, 0.05); assert.equal(u._meta.context_used, 500); assert.equal(u._meta.observations, 2); assert.equal(u.input, null);
  const e = mk(); e.onUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 3, currency: 'EUR' } }); e.onStop({ stopReason: 'end_turn' });
  assert.equal(e.finish().find((x) => x.type === 'usage').cost_estimate_usd, null);
  const n = mk(); n.onUpdate({ sessionUpdate: 'usage_update' }); n.onStop({ stopReason: 'end_turn' });
  assert.equal(n.finish().find((x) => x.type === 'usage').cost_estimate_usd, null);
  const z = mk(); z.onStop({ stopReason: 'end_turn' }); assert.ok(!z.finish().some((x) => x.type === 'usage'));
  const s = mk(); s.onUpdate({ sessionUpdate: 'usage_update', used: 9, size: 10, cost: { amount: 0, currency: 'USD' } });
  s.onStop({ stopReason: 'end_turn', usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 } });
  const su = s.finish().find((x) => x.type === 'usage'); assert.equal(su.input, 1200); assert.equal(su.output, 340); assert.equal(su.cache_read, null);
  const w = mk(); w.onStop({ stopReason: 'end_turn', usage: { inputTokens: 'x' } });
  const wu = w.finish().find((x) => x.type === 'usage'); assert.equal(wu.input, null); assert.equal(wu.cost_estimate_usd, null);
});

test('garbage updates never throw', () => {
  const m = mk();
  for (const u of [null, 1, 'x', {}, { sessionUpdate: 'plan' }, { sessionUpdate: 'tool_call' }, { sessionUpdate: 'agent_message_chunk' }, { sessionUpdate: 'agent_message_chunk', content: null }]) m.onUpdate(u);
  m.onStop(null);
  assert.equal(m.finish().at(-1).conclusion, 'failed');
});

test('readToolLog tolerates a missing file and corrupt lines', () => {
  assert.deepEqual(readToolLog('/nonexistent/x.jsonl'), { entries: [], corrupt: 0 });
  assert.deepEqual(readToolLog(null), { entries: [], corrupt: 0 });
  const d = mkdtempSync(path.join(tmpdir(), 'tl-')); const f = path.join(d, 'l.jsonl');
  writeFileSync(f, '{"tool":"a"}\nnot json\n\n{"tool":"b"}\n{"tool":');
  const r = readToolLog(f); assert.equal(r.entries.length, 2); assert.equal(r.corrupt, 2);
  assert.equal(headerOf('x\n### Title here \nbody'), 'Title here'); assert.equal(headerOf('no header'), null);
});

test('subagents become agent events from their final state, including ones a timeout left running', () => {
  const m = mk();
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'a1', kind: 'think', title: 'task', status: 'pending' });
  m.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a1', title: 'Bug hunt agent 3', status: 'in_progress', rawInput: { description: 'Bug hunt agent 3', prompt: 'x', subagent_type: 'general' } });
  m.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a1', status: 'completed', rawOutput: { output: 'done', metadata: { sessionId: 'ses_child', model: { modelID: 'muse-spark-1.3', providerID: 'opencode' } } } });
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'a2', kind: 'think', title: 'task', status: 'pending' });
  m.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a2', status: 'in_progress', rawInput: { subagent_type: 'explore' } }); // no description: title stands in
  m.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'n1', kind: 'think', title: 'not an agent', rawInput: { thought: 'hmm' } });
  m.onStop({ stopReason: 'cancelled' });
  const evs = m.finish({ conclusion: 'timed-out' });
  const ag = evs.filter((e) => e.type === 'agent');
  assert.equal(ag.length, 2);
  assert.deepEqual([ag[0].agent_id, ag[0].role, ag[0].model, ag[0]._meta.status, ag[0]._meta.session_id], ['a1', 'Bug hunt agent 3', 'muse-spark-1.3', 'completed', 'ses_child']);
  assert.deepEqual([ag[1].role, ag[1].model, ag[1]._meta.status], ['task', null, 'in_progress']);
  assert.equal(evs.at(-1)._meta.agents, 2);
});

test('a credential-shaped token in a finding, a summary or the agent text is dropped, never recorded', () => {
  const tok = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  assert.equal(looksLikeSecret(`oauth_token: ${tok}`), true);
  assert.equal(looksLikeSecret('GH_TOKEN=gho_' + 'x'.repeat(30)), true);
  assert.equal(looksLikeSecret('ANTHROPIC_AUTH_TOKEN=' + 'x'.repeat(20)), true, 'the claude row forwards this one');
  assert.equal(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
  assert.equal(looksLikeSecret('AKIAIOSFODNN7EXAMPLE'), true);
  assert.equal(looksLikeSecret('## Code review\nNo issues found.'), false);
  assert.equal(looksLikeSecret('sk-ant-short'), false, 'too short to be a key');
  const m = mk();
  m.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `here is the env: GH_TOKEN=${tok}` } });
  m.onStop({ stopReason: 'end_turn' });
  const evs = m.finish({ toolLog: [
    { tool: 'create_inline_comment', input: { path: 'a.js', body: `token ${tok}`, line: 1 } },
    { tool: 'create_inline_comment', input: { path: 'a.js', body: 'clean', line: 2 } },
    { tool: 'gh_pr_comment', input: { body: `## Code review\n${tok}` } },
    { tool: 'update_claude_comment', input: { body: 'hosts.yml: oauth_token: ' + tok } },
  ] });
  assert.equal(evs.filter((e) => e.type === 'finding').length, 1);
  assert.ok(!evs.some((e) => e.type === 'summary'), 'no summary from a secret body and no fallback to secret agent text');
  assert.equal(evs.at(-1)._meta.dropped.length, 4, 'finding, two summaries, and the agent-text fallback');
  assert.ok(!JSON.stringify(evs).includes(tok), 'the token appears nowhere in the events');
});

test('an entry the recorder already redacted is dropped with its own reason', () => {
  const m = mk();
  m.onStop({ stopReason: 'end_turn' });
  const evs = m.finish({ toolLog: [
    { tool: 'create_inline_comment', at: 't0', redacted: 'credential-shaped body', input: { path: 'a.js', body: null, line: 1 } },
    { tool: 'gh_pr_comment', at: 't1', redacted: 'credential-shaped body', input: { body: null, args: [] } },
  ] });
  assert.ok(!evs.some((e) => e.type === 'finding'), 'no finding from a redacted record');
  assert.ok(!evs.some((e) => e.type === 'summary'), 'no summary from a redacted record');
  const why = evs.at(-1)._meta.dropped.map((d) => d.why);
  assert.equal(why.filter((w) => /recorder redacted this record: credential-shaped body/.test(w)).length, 2, why.join(' | '));
});

const modelOption = (currentValue, over = {}) => ({ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue, options: [], ...over });

test('selectedModel reads only a model-category select, and nothing from an empty or odd value (prismalens#727)', () => {
  assert.equal(selectedModel([modelOption('opencode/muse')]), 'opencode/muse');
  assert.equal(selectedModel([modelOption('x', { category: 'mode' })]), null);
  assert.equal(selectedModel([{ ...modelOption(true), type: 'boolean' }]), null);
  assert.equal(selectedModel([modelOption('')]), null);
  assert.equal(selectedModel(null), null);
  assert.equal(selectedModel('model'), null);
});

test('started keeps the requested model verbatim and records the served one, flagging a substitution', () => {
  const swapped = new SessionMapper({ cwd: '/w', engine: 'opencode', model: 'gemma4:31b' });
  swapped.onSession({ sessionId: 's', configOptions: [modelOption('gemma3:12b')] });
  assert.equal(swapped.events[0].model, 'gemma4:31b');
  assert.equal(swapped.events[0]._meta.served_model, 'gemma3:12b');
  assert.equal(swapped.events[0]._meta.model_substituted, true);

  const same = new SessionMapper({ cwd: '/w', engine: 'opencode', model: 'm' });
  same.onSession({ sessionId: 's', configOptions: [modelOption('m')] });
  assert.equal(same.events[0]._meta.model_substituted, false);

  const unasked = new SessionMapper({ cwd: '/w', engine: 'claude-code' });
  unasked.onSession({ sessionId: 's', configOptions: [modelOption('claude-x')] });
  assert.equal(unasked.events[0]._meta.served_model, 'claude-x');
  assert.equal('model_substituted' in unasked.events[0]._meta, false);

  const silent = new SessionMapper({ cwd: '/w', engine: 'opencode', model: 'm' });
  silent.onSession({ sessionId: 's' });
  assert.equal(silent.events[0]._meta, undefined);
});
