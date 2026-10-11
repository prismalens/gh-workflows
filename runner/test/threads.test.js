import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ownOpenThreads, threadsToCheck, readVerdicts, checkVerdicts, applyVerdicts } from '../src/threads.js';
import { decide } from '../src/policy.js';

const HEAD = 'a'.repeat(40);
const MARK = '<!-- assayer-finding engine=codex -->';
const comment = (login, body, extra = {}) => ({ databaseId: 1, author: { login }, body, originalCommit: { oid: 'b'.repeat(40) }, ...extra });
const node = (id, comments, extra = {}) => ({ id, isResolved: false, path: 'src/a.js', line: 3, comments: { nodes: comments }, ...extra });

describe('threads (#184)', () => {
  it('takes only unresolved threads this login started with this engine\'s marker', () => {
    const nodes = [
      node('T1', [comment('me', `finding\n\n${MARK}`)]),
      node('T2', [comment('me', `finding\n\n${MARK}`)], { isResolved: true }),
      node('T3', [comment('someone', `quoting\n\n${MARK}`)]),
      node('T4', [comment('me', 'finding\n\n<!-- assayer-finding engine=opencode -->')]),
      node('T5', [comment('me', 'a note with no marker')]),
    ];
    assert.deepEqual(ownOpenThreads(nodes, { login: 'me', engine: 'codex' }).map((t) => t.thread_id), ['T1']);
  });

  it('keeps other people\'s replies and knows when someone is waiting on the reviewer', () => {
    const [t] = ownOpenThreads([node('T1', [comment('me', MARK), comment('dev', 'fixed in 123'), comment('me', `Still applies\n\n${MARK}`)])], { login: 'me', engine: 'codex' });
    assert.deepEqual(t.replies, [{ author: 'dev', body: 'fixed in 123' }]);
    assert.equal(t.awaiting, false);
    const [u] = ownOpenThreads([node('T1', [comment('me', MARK), comment('dev', 'done')])], { login: 'me', engine: 'codex' });
    assert.equal(u.awaiting, true);
  });

  it('asks a model only about threads whose file changed, that someone answered, or whose base is gone', async () => {
    const since = 'b'.repeat(40);
    const threads = [
      { thread_id: 'changed', path: 'src/a.js', since, replies: [] },
      { thread_id: 'untouched', path: 'src/z.js', since, replies: [] },
      { thread_id: 'answered', path: 'src/z.js', since, replies: [{ author: 'dev', body: 'no' }] },
      { thread_id: 'renamed', path: 'src/old.js', since, replies: [] },
      { thread_id: 'gone', path: 'src/z.js', since: 'c'.repeat(40), replies: [] },
    ];
    const api = { call: async (_m, p) => {
      if (p.includes('c'.repeat(40))) throw Object.assign(new Error('404'), { status: 404 });
      return { files: [{ filename: 'src/a.js' }, { filename: 'src/new.js', previous_filename: 'src/old.js' }] };
    } };
    const ids = (await threadsToCheck(api, 'o/r', HEAD, threads)).map((t) => t.thread_id);
    assert.deepEqual(ids, ['changed', 'answered', 'renamed', 'gone']);
  });

  it('discards a verdict on an unstaged thread, a copied path that differs, a non-head sha, or a conflict', () => {
    const threads = [{ thread_id: 'T1', path: 'src/a.js' }, { thread_id: 'T2', path: 'src/b.js' }, { thread_id: 'T3', path: 'src/c.js' }];
    const v = (o) => ({ thread_id: 'T1', path: 'src/a.js', verdict: 'fixed', sha: HEAD.slice(0, 7), evidence: 'checked', ...o });
    const { kept, discarded } = checkVerdicts([
      v({}),
      v({ thread_id: 'TX' }),
      v({ thread_id: 'T2', path: 'src/a.js' }),
      v({ thread_id: 'T2', path: 'src/b.js', sha: 'f'.repeat(7) }),
      v({ thread_id: 'T3', path: 'src/c.js', verdict: 'fixed' }),
      v({ thread_id: 'T3', path: 'src/c.js', verdict: 'still_applies' }),
      v({ thread_id: 'T3', path: 'src/c.js', verdict: 'fixed' }),
    ], threads, HEAD);
    assert.deepEqual(kept.map((k) => k.thread_id), ['T1']);
    assert.deepEqual(discarded.map((d) => d.why), ['not a staged thread', "path src/a.js is not the thread's src/b.js", 'sha fffffff is not the head', 'conflicting verdicts']);
  });

  it('withholds credential-shaped evidence and quiets mentions in it', () => {
    const { kept } = checkVerdicts([
      { thread_id: 'T1', path: 'p', verdict: 'fixed', sha: HEAD, evidence: `token ghp_${'x'.repeat(36)}` },
      { thread_id: 'T2', path: 'q', verdict: 'fixed', sha: HEAD, evidence: 'ask @claude review' },
    ], [{ thread_id: 'T1', path: 'p' }, { thread_id: 'T2', path: 'q' }], HEAD);
    assert.equal(kept[0].evidence, '(evidence withheld: credential-shaped)');
    assert.equal(kept[1].evidence, 'ask @‍claude review');
  });

  it('resolves fixed threads, replies only where someone waits, and never repeats on a resume', async () => {
    const calls = [];
    const api = {
      call: async (m, p, b) => { calls.push({ m, p, b }); return {}; },
      graphql: async (q, vars) => { calls.push({ m: 'GQL', p: vars.t }); return {}; },
    };
    const threads = [
      { thread_id: 'F', root_id: 11, path: 'a', awaiting: false },
      { thread_id: 'S', root_id: 12, path: 'b', awaiting: false },
      { thread_id: 'W', root_id: 13, path: 'c', awaiting: true },
    ];
    const verdicts = [
      { thread_id: 'F', verdict: 'fixed', evidence: 'gone' },
      { thread_id: 'S', verdict: 'still_applies', evidence: 'still there' },
      { thread_id: 'W', verdict: 'still_applies', evidence: 'the reply misreads line 4' },
    ];
    const seen = new Map();
    const journal = { has: (k) => seen.has(k), record: (k, v) => seen.set(k, v) };
    const r = await applyVerdicts({ api, repo: 'o/r', pr: 7, engine: 'codex', headSha: HEAD, threads, verdicts, journal });
    assert.deepEqual(r, { resolved: 1, replied: 2, unresolvable: 0 });
    assert.deepEqual(calls.map((c) => `${c.m} ${c.p}`), ['POST /repos/o/r/pulls/7/comments/11/replies', 'GQL F', 'POST /repos/o/r/pulls/7/comments/13/replies']);
    assert.match(calls[0].b.body, /^Verified fixed in `aaaaaaaa`\. gone\n\n<!-- assayer-finding engine=codex -->$/);
    await applyVerdicts({ api, repo: 'o/r', pr: 7, engine: 'codex', headSha: HEAD, threads, verdicts, journal });
    assert.equal(calls.length, 3);
  });

  it('keeps the fixed reply when GitHub refuses the resolve', async () => {
    const api = { call: async () => ({}), graphql: async () => { throw new Error('Resource not accessible by integration'); } };
    const r = await applyVerdicts({ api, repo: 'o/r', pr: 7, engine: 'codex', headSha: HEAD,
      threads: [{ thread_id: 'F', root_id: 1, path: 'a', awaiting: false }], verdicts: [{ thread_id: 'F', verdict: 'fixed', evidence: 'x' }] });
    assert.deepEqual(r, { resolved: 0, replied: 1, unresolvable: 1 });
  });

  it('reads verdicts from the tool log, and the policy grants only the recorder\'s verdict tool', () => {
    assert.deepEqual(readVerdicts([{ tool: 'thread_verdict', input: { thread_id: 'T' } }, { tool: 'create_inline_comment', input: {} }]), [{ thread_id: 'T' }]);
    assert.equal(decide({ kind: 'execute', rawInput: { server: 'assayer_verify', tool: 'thread_verdict' } }).allow, true);
    assert.equal(decide({ kind: 'execute', rawInput: { server: 'evil', tool: 'thread_verdict' } }).allow, false);
  });
});
