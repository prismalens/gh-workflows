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
    comments(first:50){nodes{databaseId author{login} body originalCommit{oid}}}}}}}}`;

export function github(fetchImpl, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'assayer-cli' };
  const call = async (method, p, body) => {
    const res = await fetchImpl(`${GITHUB_API}${p}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) throw Object.assign(new Error(`github ${method} ${p.split('?')[0]} ${res.status}`), { status: res.status });
    return res.json();
  };
  const graphql = async (query, variables) => {
    const r = await call('POST', '/graphql', { query, variables });
    if (r.errors?.length) throw new Error(`github graphql: ${r.errors[0].message}`);
    return r.data;
  };
  return { call, graphql };
}

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
  return nodes;
}

// Only threads this reviewer started: unresolved, first comment by `login` and ending in this
// engine's marker. Anyone else's thread, even one quoting the marker, is never touched.
export function ownOpenThreads(nodes, { login, engine }) {
  const marker = findingMarker(engine);
  const out = [];
  for (const t of nodes) {
    const comments = t.comments?.nodes ?? [];
    const first = comments[0];
    if (t.isResolved || !first || first.author?.login !== login || typeof first.body !== 'string' || !first.body.trimEnd().endsWith(marker)) continue;
    out.push({
      thread_id: t.id, root_id: first.databaseId, path: t.path, line: t.line ?? null,
      since: first.originalCommit?.oid ?? null, body: first.body,
      replies: comments.slice(1).filter((c) => c.author?.login !== login).map((c) => ({ author: c.author?.login ?? null, body: c.body })),
      // Someone spoke after the reviewer's last word, so a verdict owes them a reply.
      awaiting: comments.at(-1)?.author?.login !== login,
    });
  }
  return out;
}

// A thread whose file did not change since the finding, and that nobody answered, still stands
// without asking a model. An unreadable comparison (a force-push dropped `since`) is checked.
export async function threadsToCheck(api, repo, headSha, threads) {
  const touched = new Map();
  for (const since of new Set(threads.map((t) => t.since))) {
    if (!since || since === headSha) { touched.set(since, new Set()); continue; }
    try {
      const c = await api.call('GET', `/repos/${repo}/compare/${since}...${headSha}`);
      touched.set(since, new Set((c.files ?? []).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean))));
    } catch {
      touched.set(since, null);
    }
  }
  return threads.filter((t) => t.replies.length > 0 || touched.get(t.since) === null || touched.get(t.since).has(t.path));
}

export function readVerdicts(toolLogEntries) {
  return toolLogEntries.filter((e) => e.tool === VERDICT_TOOL && e.input && typeof e.input === 'object').map((e) => e.input);
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
          : typeof v.sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(v.sha) || !headSha.startsWith(v.sha) ? `sha ${v.sha} is not the head` : null;
    if (why) { discarded.push({ thread_id: v?.thread_id ?? null, why }); continue; }
    // Two different verdicts on one thread: neither is trusted, so it stays open.
    if (kept.has(t.thread_id) && kept.get(t.thread_id).verdict !== v.verdict) conflicted.add(t.thread_id);
    kept.set(t.thread_id, { ...v, evidence: evidenceText(v.evidence) });
  }
  for (const id of conflicted) { kept.delete(id); discarded.push({ thread_id: id, why: 'conflicting verdicts' }); }
  return { kept: [...kept.values()], discarded };
}

// Replies and resolves under the token's login. `fixed` replies and resolves; the other two
// reply only when someone is waiting on the reviewer, so a re-run never repeats itself.
export async function applyVerdicts({ api, repo, pr, engine, headSha, threads, verdicts, journal = null, log = () => {} }) {
  const byId = new Map(threads.map((t) => [t.thread_id, t]));
  const marker = findingMarker(engine);
  const out = { resolved: 0, replied: 0, unresolvable: 0 };
  for (const v of verdicts) {
    const t = byId.get(v.thread_id);
    const key = `verdict:${t.thread_id}`;
    if (journal?.has(key)) continue;
    if (v.verdict === 'fixed' || t.awaiting) {
      const body = `${TEMPLATES[v.verdict].replace('{sha}', headSha.slice(0, 8)).replace('{evidence}', v.evidence)}\n\n${marker}`;
      await api.call('POST', `/repos/${repo}/pulls/${pr}/comments/${t.root_id}/replies`, { body });
      out.replied += 1;
    }
    if (v.verdict === 'fixed') {
      try {
        await api.graphql('mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}', { t: t.thread_id });
        out.resolved += 1;
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
