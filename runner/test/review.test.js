import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, parseTarget, livenessRecords, priorReview, publish } from '../src/review.js';
import { LIVENESS_PREFIX, livenessBody } from '../../worker/poster.js';

const HEAD = 'a'.repeat(40);
const live = (over = {}) => ({
  id: 1, user: { login: 'sumit', type: 'User' }, author_association: 'OWNER',
  body: livenessBody({ rounds: 2, headSha: HEAD, engine: 'codex', model: 'gpt-6.1-sol', verdict: 'reviewed `aaaaaaa`, 1 finding inline.' }),
  ...over,
});

describe('assayer review (#184)', () => {
  it('reads owner/repo#N and a pull request URL', () => {
    assert.deepEqual(parseTarget('prismalens/sreforge#183'), { repo: 'prismalens/sreforge', pr: 183 });
    assert.deepEqual(parseTarget('https://github.com/prismalens/sreforge/pull/183'), { repo: 'prismalens/sreforge', pr: 183 });
    assert.throws(() => parseTarget('sreforge#183'));
  });

  it('prints by default and posts only when asked', () => {
    const o = parseArgs(['review', 'a/b#1']);
    assert.equal(o.post, false);
    assert.equal(o.engine, 'codex');
    assert.equal(parseArgs(['review', 'a/b#1', '--post', '--engine', 'opencode']).post, true);
    assert.throws(() => parseArgs(['review', 'a/b#1', '--engine', 'nope']), /unknown engine/);
    assert.throws(() => parseArgs(['review', 'a/b#1', '--bogus']), /unknown argument/);
  });

  it('parses liveness markers and blocks a head this engine already reviewed (OBJ-001)', () => {
    const recs = livenessRecords([live(), { id: 2, user: { login: 'x' }, body: 'hello' }]);
    assert.equal(recs.length, 1);
    assert.deepEqual({ sha: recs[0].sha, engine: recs[0].engine, rounds: recs[0].rounds, reviewed: recs[0].reviewed }, { sha: HEAD, engine: 'codex', rounds: 2, reviewed: true });
    assert.ok(priorReview(recs, { headSha: HEAD, engine: 'codex' }));
    assert.equal(priorReview(recs, { headSha: HEAD, engine: 'opencode' }), null);
    assert.equal(priorReview(recs, { headSha: 'b'.repeat(40), engine: 'codex' }), null);
  });

  it('trusts a prior review only from an App or a writer (R1)', () => {
    const drive = livenessRecords([live({ author_association: 'CONTRIBUTOR' })]);
    assert.equal(priorReview(drive, { headSha: HEAD, engine: 'codex' }), null);
    const bot = livenessRecords([live({ user: { login: 'my-assayer[bot]', type: 'Bot' }, author_association: 'NONE' })]);
    assert.ok(priorReview(bot, { headSha: HEAD, engine: 'codex' }));
  });

  it('a failed round is not a verdict: it is never published', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'assayer-pub-'));
    writeFileSync(path.join(dir, 'round.json'), JSON.stringify({ repository: 'a/b', pr_number: 1, head_sha: HEAD, engine: 'codex' }));
    writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'finished', conclusion: 'timed-out' }) + '\n');
    await assert.rejects(publish(dir, { token: 't', login: 'sumit', fetch: () => { throw new Error('no network'); } }), /ended timed-out; nothing to publish/);
    assert.ok(LIVENESS_PREFIX);
  });
});
