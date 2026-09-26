#!/usr/bin/env node
// The staging step, inside the container (#184, spec §2): check the pull request out and write the
// manifest and diff the engine reads. Its only way out is the proxy, which allows github.com and
// api.github.com in this phase. Exit 0 on success; 5 with /round/stage-error.txt on failure.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkout } from './github.js';
import { buildManifest } from './manifest.js';

export const STAGE_FAILED = 5;

export function parseStageArgs(argv) {
  const o = { repo: null, pr: null, headSha: null, baseSha: null, mode: 'review', cwd: '/checkout', out: '/round' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const v = argv[i + 1];
    const need = () => { if (v === undefined) throw new Error(`${a} needs a value`); i += 1; return v; };
    if (a === '--repo') o.repo = need();
    else if (a === '--pr') o.pr = need();
    else if (a === '--head-sha') o.headSha = need();
    else if (a === '--base-sha') o.baseSha = need();
    else if (a === '--mode') o.mode = need();
    else if (a === '--cwd') o.cwd = need();
    else if (a === '--out') o.out = need();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.repo || !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error('--repo owner/name is required');
  if (!o.pr || !/^\d+$/.test(o.pr)) throw new Error('--pr N is required');
  if (!o.headSha || !/^[0-9a-f]{40}$/.test(o.headSha)) throw new Error('--head-sha must be a 40-hex sha');
  if (o.baseSha && !/^[0-9a-f]{40}$/.test(o.baseSha)) throw new Error('--base-sha must be a 40-hex sha');
  return o;
}

export async function stage(o, { env = process.env, doCheckout = checkout, doManifest = buildManifest } = {}) {
  const token = env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set');
  const t0 = Date.now();
  await doCheckout({ repository: o.repo, headSha: o.headSha, baseSha: o.baseSha, token, dir: o.cwd });
  const m = await doManifest({ cwd: o.cwd, repo: o.repo, pr: o.pr, mode: o.mode, headSha: o.headSha, ghToken: token });
  const staged = {
    files: m.manifest?.files?.length ?? null,
    reviewable: (m.manifest?.files ?? []).filter((f) => !f.filtered_by).length,
    diff_bytes: m.diffBytes, ms: Date.now() - t0,
  };
  writeFileSync(path.join(o.out, 'staged.json'), JSON.stringify(staged) + '\n');
  writeFileSync(path.join(o.out, 'manifest-stderr.log'), m.stderr ?? '');
  return staged;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseStageArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`assayer-stage: ${e.message}\n`); process.exit(2); }
  // git and manifest.py reach GitHub only through the proxy.
  if (process.env.ASSAYER_HTTPS_PROXY) process.env.HTTPS_PROXY = process.env.https_proxy = process.env.ASSAYER_HTTPS_PROXY;
  stage(o).then(() => process.exit(0)).catch((e) => {
    try { writeFileSync(path.join(o.out, 'stage-error.txt'), `${String(e.message).split('\n')[0]}\n`); } catch { /* the daemon reports a bare exit */ }
    process.exit(STAGE_FAILED);
  });
}
