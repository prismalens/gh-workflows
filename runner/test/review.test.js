import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, parseTarget, livenessRecords, priorReview, publish, fileJournal, withheldCount } from '../src/review.js';
import { readFileSync } from 'node:fs';
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
    assert.equal(parseArgs(['review', 'a/b#1', '--verify-only']).verifyOnly, true);
    assert.throws(() => parseArgs(['review', 'a/b#1', '--verify-only', '--skip-verify']), /contradict/);
  });

  it('parses liveness markers and blocks a head this engine already reviewed (OBJ-001)', () => {
    const recs = livenessRecords([live(), { id: 2, user: { login: 'x' }, body: 'hello' }]);
    assert.equal(recs.length, 1);
    assert.deepEqual({ sha: recs[0].sha, engine: recs[0].engine, rounds: recs[0].rounds, reviewed: recs[0].reviewed }, { sha: HEAD, engine: 'codex', rounds: 2, reviewed: true });
    const canWrite = () => true;
    assert.ok(priorReview(recs, { headSha: HEAD, engine: 'codex', canWrite }));
    assert.equal(priorReview(recs, { headSha: HEAD, engine: 'opencode', canWrite }), null);
    assert.equal(priorReview(recs, { headSha: 'b'.repeat(40), engine: 'codex', canWrite }), null);
  });

  it('trusts a prior review from an App, or from a person only on effective write permission (R1)', () => {
    const owner = livenessRecords([live({ author_association: 'OWNER' })]);
    assert.equal(priorReview(owner, { headSha: HEAD, engine: 'codex', canWrite: () => false }), null);
    const contributor = livenessRecords([live({ author_association: 'CONTRIBUTOR' })]);
    assert.ok(priorReview(contributor, { headSha: HEAD, engine: 'codex', canWrite: (l) => l === 'sumit' }));
    const bot = livenessRecords([live({ user: { login: 'my-assayer[bot]', type: 'Bot' }, author_association: 'NONE' })]);
    assert.ok(priorReview(bot, { headSha: HEAD, engine: 'codex', canWrite: () => false }));
  });

  it('counts a corrupt tool-log line as a withheld finding (OBJ-005)', () => {
    assert.equal(withheldCount({ dropped: [{ tool: 'create_inline_comment' }, { tool: 'post_summary' }], tool_log_corrupt_lines: 2 }), 3);
    assert.equal(withheldCount({}), 0);
  });

  it('a failed round is not a verdict: it is never published', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'assayer-pub-'));
    writeFileSync(path.join(dir, 'round.json'), JSON.stringify({ repository: 'a/b', pr_number: 1, head_sha: HEAD, engine: 'codex' }));
    writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'finished', conclusion: 'timed-out' }) + '\n');
    await assert.rejects(publish(dir, { token: 't', login: 'sumit', fetch: () => { throw new Error('no network'); } }), /ended timed-out; nothing to publish/);
    assert.ok(LIVENESS_PREFIX);
  });

  it('a torn journal tail does not swallow the next record (live round on #246)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'assayer-journal-'));
    writeFileSync(path.join(dir, 'publish-journal.jsonl'), '{"key":"finding:0","id":1}\n{"key":"find');
    const j = fileJournal(dir);
    assert.ok(j.has('finding:0'));
    assert.equal(j.has('finding:1'), false);
    j.record('finding:1', 2);
    const again = fileJournal(dir);
    assert.ok(again.has('finding:1'));
    assert.match(readFileSync(path.join(dir, 'publish-journal.jsonl'), 'utf8'), /"find\n\{"key":"finding:1"/);
  });
});
