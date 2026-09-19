// Maps an ACP session (session/update notifications, the prompt's stop, the tool log the
// comment MCP servers wrote) onto assayer/v1 events. Pure: no I/O except readToolLog.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { event, classifyFailure, resetAtFrom } from './events.js';
import { FINDING_TOOL, SUMMARY_TOOL } from './policy.js';

export const CONCLUSIONS = Object.freeze(['completed', 'truncated', 'refused', 'cancelled', 'timed-out', 'failed']);

const STOP_TO_CONCLUSION = Object.freeze({
  end_turn: 'completed',
  max_tokens: 'truncated',
  max_turn_requests: 'truncated',
  refusal: 'refused',
  cancelled: 'cancelled',
});

export class SessionMapper {
  constructor({ cwd, engine, model, promptHash, laneVersion, credentialFingerprint }) {
    this.cwd = path.resolve(cwd);
    this.events = [event('started', {
      engine, model: model ?? null, credential_fingerprint: credentialFingerprint ?? null,
      prompt_hash: promptHash ?? null, lane_version: laneVersion ?? null,
    })];
    this.toolCalls = new Map(); // toolCallId -> merged ToolCall
    this.readPaths = new Set();
    this.agentText = [];
    this.usageObservations = [];
    this.dropped = [];
    this.stopReason = null;
    this.errored = false;
    this.toolCallCount = 0;
  }

  // Merge partial updates: a tool_call_update may carry only status, or only locations.
  #merge(update) {
    const id = update.toolCallId;
    if (!id) { this.dropped.push({ why: 'tool update without toolCallId' }); return null; }
    const prev = this.toolCalls.get(id) || { toolCallId: id };
    const next = { ...prev };
    for (const k of ['kind', 'status', 'title', 'name', 'rawInput', 'rawOutput']) {
      if (update[k] !== undefined && update[k] !== null) next[k] = update[k];
    }
    if (Array.isArray(update.locations) && update.locations.length) next.locations = update.locations;
    this.toolCalls.set(id, next);
    return next;
  }

  #emitReads(tc) {
    for (const loc of tc.locations || []) {
      if (!loc || typeof loc.path !== 'string' || !loc.path) continue;
      const abs = path.resolve(this.cwd, loc.path);
      const rel = path.relative(this.cwd, abs);
      const outside = rel.startsWith('..') || path.isAbsolute(rel);
      const key = outside ? abs : rel;
      if (this.readPaths.has(key)) continue; // one read event per path per round
      this.readPaths.add(key);
      this.events.push(event('read', { path: key }, outside ? { outside_checkout: true } : {}));
    }
  }

  onUpdate(update) {
    if (!update || typeof update !== 'object') { this.dropped.push({ why: 'non-object update' }); return; }
    switch (update.sessionUpdate) {
      case 'tool_call': {
        this.toolCallCount += 1;
        const tc = this.#merge(update);
        if (tc) this.#emitReads(tc);
        break;
      }
      case 'tool_call_update': {
        const tc = this.#merge(update);
        if (tc) this.#emitReads(tc);
        break;
      }
      case 'agent_message_chunk':
        if (update.content?.type === 'text' && typeof update.content.text === 'string') this.agentText.push(update.content.text);
        break;
      case 'usage_update':
        this.usageObservations.push({ used: update.used ?? null, size: update.size ?? null, cost: update.cost ?? null });
        break;
      default:
        break; // plan, thought chunks, mode changes, available commands: not contract
    }
  }

  onStop(response) {
    this.stopReason = response?.stopReason ?? null;
  }

  onError(err, stage = 'prompt') {
    this.errored = true;
    const message = err?.message || String(err);
    const failure_class = classifyFailure(message) || 'api-error';
    this.events.push(event('error', { failure_class, message, reset_at: resetAtFrom(message) }, { stage, code: err?.code ?? null }));
  }

  // Findings and the summary come from what the MCP servers recorded, never from tool_call
  // rawInput, so a call the engine only narrated is not a finding.
  #applyToolLog(entries) {
    let summary = null; let summaryCount = 0; let summarySource = null;
    for (const e of entries) {
      const input = e.input && typeof e.input === 'object' ? e.input : {};
      if (e.tool === FINDING_TOOL) {
        if (typeof input.path !== 'string' || typeof input.body !== 'string' || !input.body.trim()) {
          this.dropped.push({ why: 'finding without path or body', at: e.at }); continue;
        }
        const line = Number.isInteger(input.line) ? input.line : (Number.isInteger(input.endLine) ? input.endLine : null);
        const start = Number.isInteger(input.startLine) ? input.startLine : null;
        const rel = path.relative(this.cwd, path.resolve(this.cwd, input.path));
        const traversal = rel.startsWith('..') || path.isAbsolute(rel);
        this.events.push(event('finding', {
          path: traversal ? input.path : rel, line, side: input.side === 'LEFT' ? 'LEFT' : 'RIGHT',
          body: input.body, confirmed: null,
        }, { start_line: start, ...(traversal ? { path_outside_checkout: true } : {}) }));
      } else if (e.tool === SUMMARY_TOOL || e.tool === 'gh_pr_comment') {
        summaryCount += 1;
        if (typeof input.body === 'string' && input.body.trim()) { summary = input.body; summarySource = e.tool; } // last write wins, as the lane's comment does
        else this.dropped.push({ why: 'summary with empty body', at: e.at });
      } else {
        this.dropped.push({ why: `unknown tool ${e.tool}`, at: e.at });
      }
    }
    if (summary !== null) {
      this.events.push(event('summary', { header: headerOf(summary) ?? firstLine(summary), body: summary }, { source: summarySource, writes: summaryCount }));
    } else if (this.agentText.length) {
      const body = this.agentText.join('').trim();
      if (body) this.events.push(event('summary', { header: null, body }, { source: 'agent_text' }));
    }
  }

  finish({ toolLog = [], wallClockMs = null, conclusion = null } = {}) {
    this.#applyToolLog(toolLog);
    const last = this.usageObservations.at(-1);
    if (last) {
      const cost = last.cost && typeof last.cost.amount === 'number' ? last.cost.amount : null;
      this.events.push(event('usage', {
        cost_estimate_usd: last.cost?.currency && last.cost.currency !== 'USD' ? null : cost,
        model: this.events[0].model,
      }, { context_used: last.used, context_size: last.size, observations: this.usageObservations.length,
           currency: last.cost?.currency ?? null, gap: 'ACP usage_update carries context size and cost, not input/output tokens' }));
    }
    const c = conclusion
      ?? (this.errored ? 'failed' : (STOP_TO_CONCLUSION[this.stopReason] ?? (this.stopReason ? 'failed' : 'failed')));
    if (!CONCLUSIONS.includes(c)) throw new Error(`unknown conclusion ${c}`);
    this.events.push(event('finished', { conclusion: c }, {
      stop_reason: this.stopReason, tool_calls: this.toolCallCount, reads: this.readPaths.size,
      findings: this.events.filter((e) => e.type === 'finding').length,
      dropped: this.dropped, wall_clock_ms: wallClockMs,
    }));
    return this.events;
  }
}

export function firstLine(body) {
  const l = String(body).split('\n').find((x) => x.trim());
  return l ? l.trim() : null;
}

export function headerOf(body) {
  const m = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(body);
  return m ? m[1] : null;
}

// One JSON object per line. A corrupt line is counted, never fatal.
export function readToolLog(file) {
  if (!file || !existsSync(file)) return { entries: [], corrupt: 0 };
  const entries = []; let corrupt = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { corrupt += 1; }
  }
  return { entries, corrupt };
}
