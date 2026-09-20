import { test } from 'node:test';
import assert from 'node:assert/strict';
import { event, classifyFailure, resetAtFrom, EVENT_TYPES, FAILURE_CLASSES, fieldsOf } from '../src/events.js';

test('every event carries exactly its contract fields, nulls for the missing ones', () => {
  for (const t of EVENT_TYPES) {
    const e = event(t, t === 'error' ? { failure_class: 'api-error' } : {});
    assert.equal(e.v, 'assayer/v1'); assert.equal(e.type, t);
    for (const k of fieldsOf(t)) assert.ok(k in e, `${t}.${k}`);
    assert.ok(!('_meta' in e));
  }
  assert.throws(() => event('nope'));
  assert.throws(() => event('error', { failure_class: 'made-up' }));
});

test('error retryable defaults from the class and can be overridden', () => {
  assert.equal(event('error', { failure_class: 'rate-limited' }).retryable, true);
  assert.equal(event('error', { failure_class: 'auth-failed' }).retryable, false);
  assert.equal(event('error', { failure_class: 'rate-limited', retryable: false }).retryable, false);
});

test('classifyFailure covers the lane vocabulary and falls back to api-error', () => {
  const cases = {
    'HTTP 429 Too Many Requests': 'rate-limited',
    '429 weekly limit reached for opus': 'account-limit',   // account text beats the bare 429
    'You have reached your usage limit. Resets in 2h': 'account-limit',
    '401 Unauthorized: invalid api key': 'auth-failed',
    'insufficient credit balance': 'billing',
    'model claude-x does not exist': 'model-unavailable',
    'prompt is too long: 250000 tokens': 'request-too-large',
    'upstream 503 service unavailable': 'api-unavailable',
    'ECONNRESET': 'api-unavailable',
    'something odd happened': 'api-error',
  };
  for (const [msg, cls] of Object.entries(cases)) { assert.equal(classifyFailure(msg), cls, msg); assert.ok(FAILURE_CLASSES.includes(cls)); }
  assert.equal(classifyFailure(''), null); assert.equal(classifyFailure(null), null);
  assert.equal(resetAtFrom('limit reached. Resets in 1h35m27s.'), '1h35m27s');
  assert.equal(resetAtFrom('no hint'), null);
  // classify-failure records account-limit with retryable 0; the requeue rides on reset_at.
  assert.equal(event('error', { failure_class: 'account-limit', message: 'x' }).retryable, false);
  assert.equal(event('error', { failure_class: 'rate-limited', message: 'x' }).retryable, true);
});
