#!/usr/bin/env node
// `assayer review owner/repo#N`: one review round on this machine, on the operator's own engine
// sign-in, then (with --post) the findings on the pull request under the operator's own gh login.
// No control plane: identity follows where the round runs (#184, 2026-10-11 decision).
// `assayer publish <dir>` posts, or resumes posting, a round that already ran.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES } from './engines.js';
import { renderPrompt, renderCodexPrompt, promptHash, laneTokens } from './prompt.js';
import { checkout } from './github.js';
import { runRound } from './run.js';
import { LIVENESS_PREFIX, postRound } from '../../worker/poster.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `usage:
  assayer review <owner/repo#N | PR URL> [--engine codex] [--model M] [--post] [--again]
                 [--ignore-repo-config] [--out DIR]
  assayer publish <round dir>`;


export function parseTarget(s) {
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)\/?$/.exec(String(s ?? '').trim());
  if (!m) throw new Error(`cannot read ${JSON.stringify(s)} as owner/repo#N or a pull request URL`);
  return { repo: m[1], pr: Number(m[2]) };
}

export function parseArgs(argv) {
  const [cmd, target, ...rest] = argv;
  if (cmd === 'publish') {
    if (!target || rest.length) throw new Error(USAGE);
    return { cmd, dir: target };
  }
  if (cmd !== 'review' || !target) throw new Error(USAGE);
  const o = { cmd, ...parseTarget(target), engine: 'codex', model: null, post: false, again: false, ignoreRepoConfig: false, out: null };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const need = () => { const v = rest[i + 1]; if (v === undefined) throw new Error(`${a} needs a value`); i += 1; return v; };
    if (a === '--engine') o.engine = need();
    else if (a === '--model') o.model = need();
    else if (a === '--post') o.post = true;
    else if (a === '--again') o.again = true;
    else if (a === '--ignore-repo-config') o.ignoreRepoConfig = true;
    else if (a === '--out') o.out = need();
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (!(o.engine in ENGINES)) throw new Error(`unknown engine ${o.engine}; known: ${Object.keys(ENGINES).join(', ')}`);
  return o;
}

function gh(args, { allow404 = false } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gh is not available: ${r.error.message}`);
  if (r.status !== 0) {
    if (allow404 && /HTTP 404/.test(r.stderr)) return null;
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${r.stderr.trim().split('\n')[0]}`);
  }
  return r.stdout;
}

const ghJson = (p, opts) => { const s = gh(['api', p], opts); return s === null ? null : JSON.parse(s); };

// Every liveness comment on the PR with a parsed marker, oldest first.
export function livenessRecords(comments) {
  const out = [];
  for (const c of comments) {
    if (typeof c?.body !== 'string' || !c.body.startsWith(LIVENESS_PREFIX)) continue;
    const head = c.body.split('\n')[0];
    const field = (k) => (new RegExp(`\\b${k}=(\\S+)`).exec(head)?.[1] ?? null);
    out.push({
      id: c.id, login: c.user?.login ?? null, bot: c.user?.type === 'Bot',
      rounds: Number(field('rounds')) || 0, sha: field('sha'), engine: field('engine')?.replace(/-->$/, '') ?? null,
      reviewed: /: reviewed `/.test(c.body),
    });
  }
  return out;
}

// A head already reviewed by this engine, vouched for by an App or by someone who can write
// here, is not run again unless asked (OBJ-001). Association is not write access, so a person
// is checked through `canWrite(login)`, the effective permission. Returns the blocking record.
export function priorReview(records, { headSha, engine, canWrite }) {
  return records.find((r) => r.reviewed && r.sha === headSha && r.engine === engine && (r.bot || canWrite(r.login))) ?? null;
}

function writerCheck(repo) {
  const cache = new Map();
  return (login) => {
    if (!login || !/^[A-Za-z0-9-]+$/.test(login)) return false;
    if (!cache.has(login)) {
      const perm = gh(['api', `repos/${repo}/collaborators/${login}/permission`, '--jq', '.permission'], { allow404: true });
      cache.set(login, perm !== null && ['admin', 'write'].includes(perm.trim()));
    }
    return cache.get(login);
  };
}

function listComments(repo, pr) {
  const s = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`]);
  return JSON.parse(s).flat();
}

function renderFor(engine, { repo, pr, baseSha, headSha }) {
  const row = ENGINES[engine];
  const tpl = readFileSync(path.join(HERE, '..', 'prompt', row.promptTemplate ?? 'template.md'), 'utf8');
  const text = row.promptTemplate
    ? renderCodexPrompt(tpl, { repo, pr, baseSha, headSha })
    : renderPrompt(tpl, laneTokens({ repo, pr, level: 'high', mode: 'review' }));
  return { text, hash: promptHash(tpl) };
}

export function fileJournal(dir) {
  const file = path.join(dir, 'publish-journal.jsonl');
  const seen = new Map();
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    for (const l of text.split('\n').filter(Boolean)) {
      try { const e = JSON.parse(l); seen.set(e.key, e.id); } catch { /* a torn last line is a write that never finished */ }
    }
    // Close a torn tail so the next record starts on its own line instead of joining it.
    if (text && !text.endsWith('\n')) appendFileSync(file, '\n');
  }
  return { has: (k) => seen.has(k), record: (k, id) => { seen.set(k, id); appendFileSync(file, JSON.stringify({ key: k, id, at: new Date().toISOString() }) + '\n'); } };
}

export async function publish(dir, { log = (s) => process.stderr.write(s + '\n'), fetch = globalThis.fetch, token = null, login = null } = {}) {
  const round = JSON.parse(readFileSync(path.join(dir, 'round.json'), 'utf8'));
  const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const finished = events.findLast((e) => e.type === 'finished');
  // A round that did not complete has nothing to stand on; posting its liveness would
  // overwrite a standing verdict with a failure (principle 14, OBJ-004).
  if (finished?.conclusion !== 'completed') throw new Error(`the round ended ${finished?.conclusion ?? 'without finishing'}; nothing to publish`);
  token ??= gh(['auth', 'token']).trim();
  login ??= ghJson('user').login;
  const live = livenessRecords(listComments(round.repository, round.pr_number)).filter((r) => r.login === login);
  const rounds = Math.max(0, ...live.map((r) => r.rounds)) + 1;
  // Findings on an older head still land (GitHub shows them outdated); the verdict line does
  // not, or it would replace a newer head's verdict.
  const current = ghJson(`repos/${round.repository}/pulls/${round.pr_number}`).head.sha;
  const r = await postRound({ fetch, token, appLogin: login, job: round, events, rounds, journal: fileJournal(dir), skipLiveness: current !== round.head_sha });
  log(`assayer: posted ${r.inline} inline, ${r.unplaced} as comments, ${r.refused - r.unplaced} dropped, summary ${r.summary ? 'posted' : 'absent'}, as ${login}${current !== round.head_sha ? `; verdict not updated, the PR moved to ${current.slice(0, 7)}` : ''}`);
  return r;
}

function printRound(dir) {
  const s = JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lines = [`${s.conclusion}: ${s.findings ?? 0} finding(s) in ${Math.round((s.wall_clock_ms ?? 0) / 1000)}s`];
  for (const f of events.filter((e) => e.type === 'finding')) {
    const after = f.body.slice(f.body.indexOf('</details>') + 1);
    const title = (/\*\*(.+?)\*\*/.exec(after)?.[1] ?? f.body.split('\n')[0]).slice(0, 140);
    lines.push(`  ${f.path}:${f.line ?? '?'}  ${title}`);
  }
  const summary = events.findLast((e) => e.type === 'summary');
  if (summary) lines.push('', summary.body);
  process.stdout.write(lines.join('\n') + '\n');
}

export async function review(o, { log = (s) => process.stderr.write(s + '\n') } = {}) {
  const pr = ghJson(`repos/${o.repo}/pulls/${o.pr}`);
  if (pr.state !== 'open') throw new Error(`${o.repo}#${o.pr} is ${pr.merged_at ? 'merged' : pr.state}`);
  const headSha = pr.head.sha; const baseSha = pr.base.sha;

  const prior = priorReview(livenessRecords(listComments(o.repo, o.pr)), { headSha, engine: o.engine, canWrite: writerCheck(o.repo) });
  if (prior && !o.again) throw new Error(`${headSha.slice(0, 7)} already has a ${o.engine} review on record (comment ${prior.id} by ${prior.login}); pass --again to run another`);

  // Until the resolver is a package (#182), a local round knows only the workflow defaults. With
  // no repo config those are exact; with one, the round would review against the wrong rules.
  const cfg = gh(['api', `repos/${o.repo}/contents/.github/claude-review.yml?ref=${baseSha}`], { allow404: true });
  if (cfg !== null && !o.ignoreRepoConfig) throw new Error(`${o.repo} has .github/claude-review.yml, which a local round cannot apply yet (#182); pass --ignore-repo-config to review with the workflow defaults`);

  const dir = path.resolve(o.out ?? path.join(os.homedir(), '.assayer', 'reviews', `${o.repo.replace('/', '-')}-${o.pr}-${headSha.slice(0, 7)}-${Date.now()}`));
  // One directory, one round: a reused one would carry the last round's publish journal.
  if (existsSync(path.join(dir, 'round.json'))) throw new Error(`${dir} already holds a round; pick a new --out`);
  mkdirSync(dir, { recursive: true });
  const token = gh(['auth', 'token']).trim();
  const cwd = path.join(dir, 'checkout');
  log(`assayer: ${o.repo}#${o.pr} at ${headSha.slice(0, 7)} with ${o.engine}; round in ${dir}`);
  await checkout({ repository: o.repo, headSha, baseSha, token, dir: cwd });

  const prompt = renderFor(o.engine, { repo: o.repo, pr: o.pr, baseSha, headSha });
  writeFileSync(path.join(dir, 'prompt.md'), prompt.text);
  const round = { repository: o.repo, pr_number: o.pr, head_sha: headSha, base_sha: baseSha, engine: o.engine, model: o.model, where: 'local' };
  writeFileSync(path.join(dir, 'round.json'), JSON.stringify(round, null, 2) + '\n');

  const summary = await runRound({
    cwd, prompt: path.join(dir, 'prompt.md'), out: dir, engine: o.engine, model: o.model, promptHash: prompt.hash,
    stage: true, repo: o.repo, pr: String(o.pr), headSha, mode: 'review', ghToken: token, engineGh: 'offline',
    timeoutMs: (ENGINES[o.engine].timeoutMin ?? 20) * 60 * 1000, idleMs: (ENGINES[o.engine].idleMin ?? 8) * 60 * 1000,
  }, { log });
  printRound(dir);
  if (summary.conclusion !== 'completed') return { dir, summary, posted: null };
  if (!o.post) { log(`assayer: not posted; run \`assayer publish ${dir}\` to post it`); return { dir, summary, posted: null }; }
  return { dir, summary, posted: await publish(dir, { log, token }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  const run = o.cmd === 'publish' ? publish(path.resolve(o.dir)).then(() => 0) : review(o).then((r) => (r.summary.conclusion === 'completed' ? 0 : 3));
  run.then((code) => process.exit(code)).catch((e) => { process.stderr.write(`assayer: ${e.message}\n`); process.exit(1); });
}
