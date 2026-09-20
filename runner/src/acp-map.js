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
    this.stopUsage = null;
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

  // Only a read or search tool reads. OpenCode reports the working directory as a location on
  // every shell command, and the root itself is not a file the round read.
  #emitReads(tc) {
    if (!['read', 'search'].includes(tc.kind)) return;
    for (const loc of tc.locations || []) {
      if (!loc || typeof loc.path !== 'string' || !loc.path) continue;
      const abs = path.resolve(this.cwd, loc.path);
      const rel = path.relative(this.cwd, abs);
      if (rel === '') continue;
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
    // Not in the ACP schema: OpenCode puts token counts on the prompt response. Taken when
    // present, so the usage event's input/output are filled where the engine says them.
    const u = response?.usage;
    if (u && typeof u === 'object') {
      const n = (k) => (Number.isFinite(u[k]) ? u[k] : null);
      this.stopUsage = { input: n('inputTokens'), output: n('outputTokens'), total: n('totalTokens') };
    }
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
      // The recorder already refused this body; say so rather than blaming a missing field.
      if (e.redacted) { this.dropped.push({ why: `recorder redacted a ${e.redacted}`, at: e.at }); continue; }
      if (e.tool === FINDING_TOOL) {
        if (typeof input.path !== 'string' || typeof input.body !== 'string' || !input.body.trim()) {
          this.dropped.push({ why: 'finding without path or body', at: e.at }); continue;
        }
        if (looksLikeSecret(input.body)) { this.dropped.push({ why: 'finding body carries a credential-shaped token', at: e.at }); continue; }
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
        if (typeof input.body === 'string' && looksLikeSecret(input.body)) { this.dropped.push({ why: 'summary body carries a credential-shaped token', at: e.at }); continue; }
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
      if (body && looksLikeSecret(body)) this.dropped.push({ why: 'agent text carries a credential-shaped token; no summary' });
      else if (body) this.events.push(event('summary', { header: null, body }, { source: 'agent_text' }));
    }
  }

  // A subagent is a tool call whose input names a subagent type (OpenCode's `task`, kind
  // `think`). One `agent` event per subagent, from its final merged state, so a round cut by a
  // timeout still lists the agents it had running. Their reads and usage stay inside their own
  // sessions under ACP's flat default, which is recorded as the gap.
  #emitAgents() {
    for (const tc of this.toolCalls.values()) {
      const ri = tc.rawInput;
      if (!ri || typeof ri !== 'object' || typeof ri.subagent_type !== 'string') continue;
      const ro = tc.rawOutput && typeof tc.rawOutput === 'object' ? tc.rawOutput : null;
      const model = ro?.metadata?.model?.modelID ?? ro?.metadata?.model ?? null;
      this.events.push(event('agent', {
        agent_id: tc.toolCallId, role: typeof ri.description === 'string' && ri.description ? ri.description : (tc.title ?? null),
        model: typeof model === 'string' ? model : null, usage: null,
      }, { subagent_type: ri.subagent_type, status: tc.status ?? null, session_id: ro?.metadata?.sessionId ?? null,
           gap: 'subagent reads and usage stay in the child session under ACP' }));
    }
  }

  finish({ toolLog = [], wallClockMs = null, conclusion = null } = {}) {
    this.#emitAgents();
    this.#applyToolLog(toolLog);
    const last = this.usageObservations.at(-1);
    if (last || this.stopUsage) {
      const cost = last?.cost && typeof last.cost.amount === 'number' ? last.cost.amount : null;
      this.events.push(event('usage', {
        input: this.stopUsage?.input ?? null, output: this.stopUsage?.output ?? null,
        cost_estimate_usd: last?.cost?.currency && last.cost.currency !== 'USD' ? null : cost,
        model: this.events[0].model,
      }, { context_used: last?.used ?? null, context_size: last?.size ?? null, observations: this.usageObservations.length,
           currency: last?.cost?.currency ?? null,
           source: this.stopUsage ? 'usage_update + prompt response usage' : 'usage_update',
           gap: this.stopUsage ? 'cache_read and cache_write are not carried by ACP' : 'ACP usage_update carries context size and cost, not input/output tokens' }));
    }
    const c = conclusion
      ?? (this.errored ? 'failed' : (STOP_TO_CONCLUSION[this.stopReason] ?? (this.stopReason ? 'failed' : 'failed')));
    if (!CONCLUSIONS.includes(c)) throw new Error(`unknown conclusion ${c}`);
    this.events.push(event('finished', { conclusion: c }, {
      stop_reason: this.stopReason, tool_calls: this.toolCallCount, reads: this.readPaths.size,
      agents: this.events.filter((e) => e.type === 'agent').length,
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

// Registered credential shapes. A finding or summary body carrying one is dropped, never
// recorded: the poster publishes these bodies, and a steered engine can put anything it read
// into them. Same rule the design gives the poster (section 5).
const SECRET_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:oauth_token|GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY)\s*[:=]\s*\S{8,}/,
];
export function looksLikeSecret(text) {
  const s = String(text || '');
  return SECRET_SHAPES.some((re) => re.test(s));
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
