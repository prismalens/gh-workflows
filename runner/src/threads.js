// The reviewer re-checks its own open threads on a new head and resolves the fixed ones (#184).
// The engine only judges; this module picks the threads, checks every verdict against the live
// thread, and posts the reply and the resolve under the reviewer's own login, as the Actions
// lane's verify and mutate jobs do (claude-code-review.yml, #17).
import { findingMarker, looksLikeSecret, quiet } from '../../worker/poster.js';
import { VERDICT_TOOL } from './policy.js';

const GITHUB_API = 'https://api.github.com';
const VERDICTS = new Set(['fixed', 'still_applies', 'cannot_verify']);
const TEMPLATES = {
  fixed: 'Verified fixed in `{sha}`. {evidence}',
  still_applies: 'Still applies to `{sha}`: {evidence}',
  cannot_verify: 'Could not verify against `{sha}`: {evidence}',
};

const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){
  reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved path line
    comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login} body originalCommit{oid}}}}}}}}`;

export function github(fetchImpl, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'assayer-cli' };
  // A read that hits a network error is tried again; a write is not, since it may have landed.
  const call = async (method, p, body, { retry = method === 'GET' } = {}) => {
    let res;
    for (let attempt = 1; ; attempt += 1) {
      try {
        res = await fetchImpl(`${GITHUB_API}${p}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        break;
      } catch (e) {
        if (!retry || attempt === 3) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!res.ok) throw Object.assign(new Error(`github ${method} ${p.split('?')[0]} ${res.status}`), { status: res.status });
    return res.json();
  };
  const graphql = async (query, variables) => {
    const r = await call('POST', '/graphql', { query, variables }, { retry: !query.trimStart().startsWith('mutation') });
    if (r.errors?.length) throw new Error(`github graphql: ${r.errors[0].message}`);
    return r.data;
  };
  return { call, graphql };
}

const MORE_COMMENTS = `query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{
  comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{databaseId author{login} body originalCommit{oid}}}}}}`;

export async function listThreads(api, repo, pr) {
  const [o, r] = repo.split('/');
  const nodes = [];
  let after = null;
  do {
    const d = await api.graphql(THREADS_QUERY, { o, r, n: pr, after });
    const page = d.repository.pullRequest.reviewThreads;
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  // A long thread's later replies are what a verdict must answer, so every page is read.
  for (const t of nodes) {
    let more = t.comments?.pageInfo?.hasNextPage ? t.comments.pageInfo.endCursor : null;
    while (more) {
      const c = (await api.graphql(MORE_COMMENTS, { id: t.id, after: more })).node.comments;
      t.comments.nodes.push(...c.nodes);
      more = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null;
    }
  }
  return nodes;
}

// Only threads this reviewer started: unresolved, first comment by `login` and ending in this
// engine's marker. Anyone else's thread, even one quoting the marker, is never touched. Within a
// thread the reviewer's own comments are told by the marker, not the login: run locally, the
// reviewer and the PR's author are often the same account.
export function ownOpenThreads(nodes, { login, engine }) {
  const marker = findingMarker(engine);
  const ours = (c) => c?.author?.login === login && typeof c.body === 'string' && c.body.trimEnd().endsWith(marker);
  const out = [];
  for (const t of nodes) {
    const comments = t.comments?.nodes ?? [];
    const first = comments[0];
    if (t.isResolved || !first || first.author?.login !== login || typeof first.body !== 'string' || !first.body.trimEnd().endsWith(marker)) continue;
    out.push({
      thread_id: t.id, root_id: first.databaseId, path: t.path, line: t.line ?? null,
      since: first.originalCommit?.oid ?? null, body: first.body,
      replies: comments.slice(1).filter((c) => !ours(c)).map((c) => ({ author: c.author?.login ?? null, body: c.body })),
      // Someone spoke after the reviewer's last word, so a verdict owes them a reply.
      awaiting: !ours(comments.at(-1)),
      // The whole conversation as judged, edits included, to tell when a verdict went stale.
      conversation: JSON.stringify(comments.map((c) => [c.author?.login ?? null, c.body])),
    });
  }
  return out;
}

// A thread whose file did not change since the finding, and that nobody answered, still stands
// without asking a model. A comparison that cannot be trusted is checked: no `since`, unreadable
// (a force-push dropped it), not a straight line from `since` to head, or at GitHub's
// 300-file cap.
export async function threadsToCheck(api, repo, headSha, threads) {
  const touched = new Map();
  for (const since of new Set(threads.map((t) => t.since))) {
    if (!since) { touched.set(since, null); continue; }
    if (since === headSha) { touched.set(since, new Set()); continue; }
    try {
      const c = await api.call('GET', `/repos/${repo}/compare/${since}...${headSha}`);
      const files = c.files ?? [];
      touched.set(since, c.status !== 'ahead' || files.length >= 300 ? null : new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean))));
    } catch {
      touched.set(since, null);
    }
  }
  return threads.filter((t) => t.replies.length > 0 || touched.get(t.since) === null || touched.get(t.since).has(t.path));
}

export function readVerdicts(toolLogEntries) {
  // A record the recorder redacted has lost its evidence, so it cannot carry a verdict.
  return toolLogEntries.filter((e) => e.tool === VERDICT_TOOL && !e.redacted && e.input && typeof e.input === 'object').map((e) => e.input);
}

function evidenceText(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return looksLikeSecret(t) ? '(evidence withheld: credential-shaped)' : quiet(t);
}

// Each verdict is bound to a thread the CLI staged and to the path the engine copied from it;
// a mismatch is discarded, since a misaligned verdict replies about the wrong finding.
export function checkVerdicts(verdicts, threads, headSha) {
  const byId = new Map(threads.map((t) => [t.thread_id, t]));
  const kept = new Map();
  const conflicted = new Set();
  const discarded = [];
  for (const v of verdicts) {
    const t = byId.get(v?.thread_id);
    const why = !t ? 'not a staged thread'
      : v.path !== t.path ? `path ${v.path} is not the thread's ${t.path}`
        : !VERDICTS.has(v.verdict) ? `verdict ${v.verdict}`
          : typeof v.sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(v.sha) || !headSha.startsWith(v.sha) ? `sha ${v.sha} is not the head`
            : typeof v.evidence !== 'string' || !v.evidence.trim() ? 'no evidence' : null;
    if (why) { discarded.push({ thread_id: v?.thread_id ?? null, why }); continue; }
    // Two different verdicts on one thread: neither is trusted, so it stays open.
    if (kept.has(t.thread_id) && kept.get(t.thread_id).verdict !== v.verdict) conflicted.add(t.thread_id);
    kept.set(t.thread_id, { ...v, evidence: evidenceText(v.evidence) });
  }
  for (const id of conflicted) { kept.delete(id); discarded.push({ thread_id: id, why: 'conflicting verdicts' }); }
  const missing = threads.filter((t) => !kept.has(t.thread_id)).map((t) => t.thread_id);
  return { kept: [...kept.values()], discarded, missing };
}

// Replies and resolves under the token's login. `fixed` replies and resolves; the other two
// reply only when someone is waiting on the reviewer, so a re-run never repeats itself.
export async function applyVerdicts({ api, repo, pr, engine, login, headSha, threads, verdicts, journal = null, log = () => {} }) {
  const byId = new Map(threads.map((t) => [t.thread_id, t]));
  const marker = findingMarker(engine);
  const out = { resolved: 0, replied: 0, unresolvable: 0, stale: 0, resolvedIds: [] };
  // The verdicts judged one head and one conversation. A push, or any new or edited comment on
  // the thread, makes a verdict stale, so it is not applied. The head is asked again before each
  // thread, since GitHub has no conditional write.
  const live = new Map(ownOpenThreads(await listThreads(api, repo, pr), { login, engine }).map((t) => [t.thread_id, t]));
  for (const v of verdicts) {
    const t = byId.get(v.thread_id);
    const key = `verdict:${t.thread_id}`;
    if (journal?.has(key)) continue;
    const pull = await api.call('GET', `/repos/${repo}/pulls/${pr}`);
    if (pull.head?.sha !== headSha) { log(`assayer: the PR moved to ${String(pull.head?.sha).slice(0, 7)}; the remaining verdicts are not applied`); out.stale += 1; continue; }
    const now = live.get(t.thread_id);
    if (!now || now.conversation !== t.conversation) { out.stale += 1; continue; }
    if (v.verdict === 'fixed' || t.awaiting) {
      const text = TEMPLATES[v.verdict].replace('{sha}', () => headSha.slice(0, 8)).replace('{evidence}', () => v.evidence);
      const body = `${text}\n\n${marker}`;
      await api.call('POST', `/repos/${repo}/pulls/${pr}/comments/${t.root_id}/replies`, { body });
      out.replied += 1;
    }
    if (v.verdict === 'fixed') {
      if ((await api.call('GET', `/repos/${repo}/pulls/${pr}`)).head?.sha !== headSha) { log('assayer: the PR moved while replying; the thread stays open'); out.stale += 1; journal?.record(key, 'stale'); continue; }
      try {
        await api.graphql('mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}', { t: t.thread_id });
        out.resolved += 1;
        out.resolvedIds.push(t.thread_id);
      } catch (e) {
        // GitHub wants push access to resolve; the reply above still says it is fixed.
        out.unresolvable += 1;
        log(`assayer: could not resolve ${t.path} (${e.message}); the reply says it is fixed`);
      }
    }
    journal?.record(key, v.verdict);
  }
  return out;
}
