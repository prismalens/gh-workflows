import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ownOpenThreads, threadsToCheck, readVerdicts, checkVerdicts, applyVerdicts } from '../src/threads.js';
import { decide } from '../src/policy.js';

const HEAD = 'a'.repeat(40);
const MARK = '<!-- assayer-finding engine=codex -->';
const comment = (login, body, extra = {}) => ({ databaseId: 1, author: { login }, body, originalCommit: { oid: 'b'.repeat(40) }, ...extra });
const node = (id, comments, extra = {}) => ({ id, isResolved: false, path: 'src/a.js', line: 3, comments: { nodes: comments }, ...extra });
const listing = (nodes) => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
// A GitHub double: the PR's head, the thread listing, and a record of every write.
function liveApi(nodes, calls, head = HEAD) {
  return {
    call: async (m, p, b) => { calls.push({ m, p, b }); return m === 'GET' ? { head: { sha: head } } : {}; },
    graphql: async (q, vars) => {
      if (q.startsWith('mutation')) { calls.push({ m: 'GQL', p: vars.t }); return {}; }
      calls.push({ m: 'LIST' });
      return listing(nodes);
    },
  };
}

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
      return { status: 'ahead', files: [{ filename: 'src/a.js' }, { filename: 'src/new.js', previous_filename: 'src/old.js' }] };
    } };
    const ids = (await threadsToCheck(api, 'o/r', HEAD, threads)).map((t) => t.thread_id);
    assert.deepEqual(ids, ['changed', 'answered', 'renamed', 'gone']);
  });

  it('checks every thread when the comparison diverged or hit the 300-file cap', async () => {
    const t = [{ thread_id: 'x', path: 'src/z.js', since: 'b'.repeat(40), replies: [] }];
    const diverged = { call: async () => ({ status: 'diverged', files: [] }) };
    const capped = { call: async () => ({ status: 'ahead', files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) }) };
    assert.equal((await threadsToCheck(diverged, 'o/r', HEAD, t)).length, 1);
    assert.equal((await threadsToCheck(capped, 'o/r', HEAD, t)).length, 1);
  });

  it('skips a thread longer than one page, which cannot be read whole', () => {
    assert.equal(ownOpenThreads([node('T1', [comment('me', MARK)], { comments: { totalCount: 101, nodes: [comment('me', MARK)] } })], { login: 'me', engine: 'codex' }).length, 0);
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
    const liveNodes = [
      node('F', [comment('me', MARK)], { path: 'a' }),
      node('S', [comment('me', MARK)], { path: 'b' }),
      node('W', [comment('me', MARK), comment('dev', 'disagree')], { path: 'c' }),
    ];
    const api = liveApi(liveNodes, calls);
    const threads = ownOpenThreads(liveNodes, { login: 'me', engine: 'codex' }).map((t, i) => ({ ...t, root_id: 11 + i }));
    const verdicts = [
      { thread_id: 'F', verdict: 'fixed', evidence: 'gone' },
      { thread_id: 'S', verdict: 'still_applies', evidence: 'still there' },
      { thread_id: 'W', verdict: 'still_applies', evidence: 'the reply misreads line 4' },
    ];
    const seen = new Map();
    const journal = { has: (k) => seen.has(k), record: (k, v) => seen.set(k, v) };
    const r = await applyVerdicts({ api, repo: 'o/r', pr: 7, engine: 'codex', login: 'me', headSha: HEAD, threads, verdicts, journal });
    assert.deepEqual(r, { resolved: 1, replied: 2, unresolvable: 0, stale: 0 });
    const writes = calls.filter((c) => c.m !== 'GET' && c.m !== 'LIST');
    assert.deepEqual(writes.map((c) => `${c.m} ${c.p}`), ['POST /repos/o/r/pulls/7/comments/11/replies', 'GQL F', 'POST /repos/o/r/pulls/7/comments/13/replies']);
    assert.match(writes[0].b.body, /^Verified fixed in `aaaaaaaa`\. gone\n\n<!-- assayer-finding engine=codex -->$/);
    await applyVerdicts({ api, repo: 'o/r', pr: 7, engine: 'codex', login: 'me', headSha: HEAD, threads, verdicts, journal });
    assert.equal(calls.filter((c) => c.m !== 'GET' && c.m !== 'LIST').length, 3);
  });

  it('applies nothing once the head moved, and skips a thread that changed since the check', async () => {
    const calls = [];
    const nodes = [node('F', [comment('me', MARK)], { path: 'a' }), node('G', [comment('me', MARK)], { path: 'b' })];
    const threads = ownOpenThreads(nodes, { login: 'me', engine: 'codex' });
    const verdicts = [{ thread_id: 'F', verdict: 'fixed', evidence: 'x' }, { thread_id: 'G', verdict: 'fixed', evidence: 'y' }];
    const moved = await applyVerdicts({ api: liveApi(nodes, calls, 'f'.repeat(40)), repo: 'o/r', pr: 7, engine: 'codex', login: 'me', headSha: HEAD, threads, verdicts });
    assert.equal(moved.stale, 2);
    const later = [node('F', [comment('me', MARK), comment('dev', 'wait, not yet')], { path: 'a' }), nodes[1]];
    const r = await applyVerdicts({ api: liveApi(later, calls), repo: 'o/r', pr: 7, engine: 'codex', login: 'me', headSha: HEAD, threads, verdicts });
    assert.deepEqual(r, { resolved: 1, replied: 1, unresolvable: 0, stale: 1 });
  });

  it('keeps the fixed reply when GitHub refuses the resolve', async () => {
    const nodes = [node('F', [comment('me', MARK)], { path: 'a' })];
    const api = liveApi(nodes, []);
    api.graphql = async (q, vars) => { if (q.startsWith('mutation')) throw new Error('Resource not accessible by integration'); return listing(nodes); };
    const r = await applyVerdicts({ api, repo: 'o/r', pr: 7, engine: 'codex', login: 'me', headSha: HEAD,
      threads: ownOpenThreads(nodes, { login: 'me', engine: 'codex' }), verdicts: [{ thread_id: 'F', verdict: 'fixed', evidence: 'x' }] });
    assert.deepEqual(r, { resolved: 0, replied: 1, unresolvable: 1, stale: 0 });
  });

  it('reads verdicts from the tool log, and the policy grants only the recorder\'s verdict tool', () => {
    assert.deepEqual(readVerdicts([{ tool: 'thread_verdict', input: { thread_id: 'T' } }, { tool: 'create_inline_comment', input: {} }]), [{ thread_id: 'T' }]);
    assert.equal(decide({ kind: 'execute', rawInput: { server: 'assayer_verify', tool: 'thread_verdict' } }).allow, true);
    assert.equal(decide({ kind: 'execute', rawInput: { server: 'evil', tool: 'thread_verdict' } }).allow, false);
  });
});
