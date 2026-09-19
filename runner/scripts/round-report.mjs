#!/usr/bin/env node
// Render one round's output directory as a markdown report: what ran, what it cost, what it
// read, refused and found, and the assayer/v1 events verbatim. Usage: round-report.mjs <out-dir>
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(path.join(dir, 'summary.json'))) { console.error('usage: round-report.mjs <out-dir with summary.json>'); process.exit(2); }
const s = JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const jsonl = (f) => existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const events = jsonl('events.jsonl'); const raw = jsonl('raw.jsonl');
const perms = raw.filter((r) => r.kind === 'permission');
const updates = raw.filter((r) => r.kind === 'update');
const first = updates[0]?.at; const last = updates.at(-1)?.at;
const started = events.find((e) => e.type === 'started');
const mins = (ms) => (ms / 60000).toFixed(1);
const lines = [];
lines.push(`| | |`, `|---|---|`,
  `| engine | \`${s.engine}\` (${started?._meta?.agent?.name ?? '?'} ${started?._meta?.agent?.version ?? ''}, ACP v${started?._meta?.protocol ?? '?'}) |`,
  `| model | \`${s.model ?? 'engine default'}\` |`,
  `| conclusion | **${s.conclusion}**${s.timed_out_by ? ` (${s.timed_out_by} clock)` : ''}, stop reason \`${s.stop_reason ?? 'none'}\` |`,
  `| wall clock | ${mins(s.wall_clock_ms)} min |`,
  `| turns | ${s.turns} prompt turn, ${s.tool_calls} tool calls, ${updates.length} session updates |`,
  `| reads | ${s.reads} |`,
  `| permissions | ${s.permissions.allowed} allowed, ${s.permissions.rejected} refused |`,
  `| findings | ${s.findings}; summary ${s.summary ? 'present' : 'absent'} |`,
  `| usage | ${s.usage ? `cost ${s.usage.cost_estimate_usd ?? 'n/a'} ${s.usage._meta?.currency ?? ''}, context ${s.usage._meta?.context_used ?? '?'} of ${s.usage._meta?.context_size ?? '?'}; input/output tokens not carried by ACP` : 'no usage_update received'} |`,
  `| prompt hash | \`${started?.prompt_hash ?? 'none'}\` at lane \`${started?.lane_version ?? '?'}\` |`,
  `| errors | ${s.errors.length ? s.errors.map((e) => `${e.failure_class}: ${e.message}`).join('; ') : 'none'} |`);
if (perms.length) {
  lines.push('', '**Permission requests**', '', '| kind | tool | decision |', '|---|---|---|');
  for (const p of perms) lines.push(`| ${p.toolCall.kind ?? '?'} | \`${String(p.toolCall.title ?? '').slice(0, 80).replace(/\|/g, '\\|')}\` | ${p.decision.allow ? 'allowed' : 'refused'}: ${p.decision.reason} |`);
}
const reads = events.filter((e) => e.type === 'read');
if (reads.length) lines.push('', '**Read**: ' + reads.map((r) => `\`${r.path}\``).join(', '));
const findings = events.filter((e) => e.type === 'finding');
for (const f of findings) lines.push('', `**Finding** \`${f.path}:${f.line ?? '?'}\` (${f.side})`, '', f.body.split('\n').map((l) => '> ' + l).join('\n'));
const summary = events.find((e) => e.type === 'summary');
if (summary) lines.push('', `**Summary** (source: ${summary._meta?.source})`, '', summary.body.split('\n').map((l) => '> ' + l).join('\n'));
if (s.dropped?.length) lines.push('', `**Dropped**: ${s.dropped.map((d) => d.why).join('; ')}`);
lines.push('', '<details><summary>assayer/v1 events</summary>', '', '```json', ...events.map((e) => JSON.stringify(e)), '```', '</details>');
lines.push('', `Raw ACP stream: ${raw.length} messages${first ? `, first update ${first}, last ${last}` : ''}.`);
process.stdout.write(lines.join('\n') + '\n');
