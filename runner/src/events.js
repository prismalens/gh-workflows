// assayer/v1: the event stream every engine emits and the control plane consumes.
// Field lists are the contract in docs/design/self-hosted-review.md section 4.

export const EVENT_TYPES = Object.freeze([
  'started', 'read', 'agent', 'finding', 'summary', 'usage', 'error', 'finished',
]);

// Mirrors classify-failure in claude-code-review.yml. A class outside this list is a bug.
export const FAILURE_CLASSES = Object.freeze([
  'account-limit', 'api-error', 'api-unavailable', 'auth-failed', 'billing',
  'model-unavailable', 'rate-limited', 'request-too-large',
]);

// account-limit is not retryable on its own, as classify-failure records it; the design still
// requeues it when reset_at says when.
export const RETRYABLE = Object.freeze(new Set(['rate-limited', 'api-unavailable']));

const FIELDS = Object.freeze({
  started: ['engine', 'model', 'credential_fingerprint', 'prompt_hash', 'lane_version'],
  read: ['path'],
  agent: ['agent_id', 'role', 'model', 'usage'],
  finding: ['path', 'line', 'side', 'category', 'severity', 'effort', 'body', 'verification_note', 'ai_prompt', 'confirmed'],
  summary: ['header', 'body'],
  usage: ['input', 'output', 'cache_read', 'cache_write', 'cost_estimate_usd', 'model'],
  error: ['failure_class', 'retryable', 'reset_at', 'message'],
  finished: ['conclusion'],
});

export function event(type, data = {}, extra = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`assayer/v1: unknown event type ${type}`);
  const out = { v: 'assayer/v1', type, at: new Date().toISOString() };
  for (const k of FIELDS[type]) out[k] = k in data ? data[k] : null;
  if (type === 'error') {
    if (!FAILURE_CLASSES.includes(out.failure_class)) throw new Error(`assayer/v1: unknown failure_class ${out.failure_class}`);
    if (out.retryable === null) out.retryable = RETRYABLE.has(out.failure_class);
  }
  // Extension slot, mirrors ACP's _meta: adapter-specific detail that is not contract.
  if (Object.keys(extra).length) out._meta = extra;
  return out;
}

export function fieldsOf(type) { return FIELDS[type]; }

// Sort an engine's error text into the lane's vocabulary. Same tests classify-failure runs on
// the action's result item, applied to whatever the ACP agent said when it stopped.
export function classifyFailure(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  // Account-limit text beats a bare 429, the order classify-failure uses: a `429 weekly limit`
  // is account-limit, not a rate limit.
  if (/usage limit|quota|five.hour|weekly limit|limit reached/.test(s)) return 'account-limit';
  if (/rate.?limit|429|too many requests/.test(s)) return 'rate-limited';
  if (/401|403|unauthori[sz]ed|invalid.*(api key|token)|authentication/.test(s)) return 'auth-failed';
  if (/billing|payment|insufficient (credit|fund)|credit balance/.test(s)) return 'billing';
  if (/model.*(not found|unavailable|does not exist)|unknown model|404.*model/.test(s)) return 'model-unavailable';
  if (/too large|context length|maximum context|413|prompt is too long/.test(s)) return 'request-too-large';
  if (/overloaded|503|502|unavailable|timed? ?out|econnreset|enotfound/.test(s)) return 'api-unavailable';
  return 'api-error';
}

export function resetAtFrom(text) {
  const m = /resets? (?:in|at) ([^.\n]+)/i.exec(String(text || ''));
  return m ? m[1].trim() : null;
}
