// The runner's client for the Worker's /runner/* routes (#184, worker/README.md "Control plane").
// Every method throws ControlPlaneError on a non-2xx, with the body's `error` code.

export const MAX_EVENTS_PER_POST = 100;
export const MAX_EVENT_BYTES = 16384;

export class ControlPlaneError extends Error {
  constructor(status, code) {
    super(`control plane ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ControlPlaneError';
    this.status = status;
    this.code = code;
  }
}

async function errorOf(res) {
  let code = null;
  try { code = (await res.json())?.error ?? null; } catch { /* empty body */ }
  return new ControlPlaneError(res.status, code);
}

export function createControlPlane({ baseUrl, token, fetch = globalThis.fetch }) {
  const call = async (method, path, { body, signal, timeoutMs = 30000 } = {}) => {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ControlPlaneError(0, 'network');
    }
    if (!res.ok) throw await errorOf(res);
    return res;
  };
  return {
    async register({ placement, credentials }) {
      const res = await call('POST', '/runner/register', {
        body: { placement, credentials: credentials.map(({ engine, kind, fingerprint, concurrency }) => ({ engine, kind, fingerprint, concurrency })) },
      });
      return res.json();
    },
    async lease({ engine, kind, wait, signal }) {
      const q = new URLSearchParams({ engine, kind, wait: String(wait) });
      const res = await call('GET', `/runner/lease?${q}`, { signal, timeoutMs: (wait + 15) * 1000 });
      return res.status === 204 ? null : res.json();
    },
    async postEvents(jobId, events, { signal } = {}) {
      await call('POST', `/runner/jobs/${encodeURIComponent(jobId)}/events`, { body: { events }, signal });
    },
  };
}

const CUTTABLE = ['body', 'message', 'ai_prompt', 'verification_note'];
const byteLength = (v) => Buffer.byteLength(JSON.stringify(v));

// An event over the Worker's 16 KiB cap is cut rather than dropped: its longest text fields are
// shortened, longest first, and the event says so.
export function fitEvent(ev) {
  if (byteLength(ev) <= MAX_EVENT_BYTES) return ev;
  const out = { ...ev, _meta: { ...(ev._meta ?? {}), truncated: true } };
  const fields = CUTTABLE.filter((k) => typeof out[k] === 'string').sort((a, b) => out[b].length - out[a].length);
  for (const k of fields) {
    const over = byteLength(out) - MAX_EVENT_BYTES;
    if (over <= 0) break;
    const keep = Math.max(0, out[k].length - over - 16);
    out[k] = `${out[k].slice(0, keep)}…`;
    while (byteLength(out) > MAX_EVENT_BYTES && out[k].length > 1) out[k] = `${out[k].slice(0, Math.floor(out[k].length * 0.9))}…`;
  }
  return out;
}

export function batches(events) {
  const out = [];
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_POST) out.push(events.slice(i, i + MAX_EVENTS_PER_POST));
  return out;
}

export function redact(text, secrets) {
  let s = String(text);
  for (const v of secrets) if (v) s = s.split(v).join('[redacted]');
  return s;
}
