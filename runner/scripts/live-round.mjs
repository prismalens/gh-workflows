#!/usr/bin/env node
// One real round on this box, through both container steps and the key proxy, with no control
// plane (#184). Usage: GH_READ_TOKEN=... node scripts/live-round.mjs --config <file> --repo o/r --pr N
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createContext, prepareContainer, runJob } from '../src/daemon.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const [file, repository, pr] = [arg('--config'), arg('--repo'), arg('--pr')];
const token = process.env.GH_READ_TOKEN;
if (!file || !repository || !/^\d+$/.test(pr ?? '') || !token) {
  process.stderr.write('usage: GH_READ_TOKEN=... live-round.mjs --config <file> --repo owner/name --pr N\n');
  process.exit(2);
}

const config = loadConfig(file);
const credential = config.credentials[0];
const view = JSON.parse(execFileSync('gh', ['pr', 'view', pr, '--repo', repository, '--json', 'headRefOid,baseRefOid'], { env: { ...process.env, GH_TOKEN: token }, encoding: 'utf8' }));
const { container, probe } = await prepareContainer(config);
process.stdout.write(`probe ${JSON.stringify(probe)}\n`);

let kept = null;
const cp = { postEvents: async (_id, events) => { for (const e of events) process.stdout.write(`event ${e.type}${e.type === 'finished' ? ` ${JSON.stringify(e._meta)}` : ''}\n`); } };
const secrets = new Set([...(config.secrets?.values() ?? []), token]);
const ctx = {
  ...createContext(config, { revoke: async () => false, rmDir: (d) => { kept = d; } }, container, {
    log: (m) => process.stderr.write(`${m}\n`), secrets, cp, stopSignal: new AbortController().signal,
  }),
  credential,
};
const job = {
  id: randomUUID(), repository, pr_number: Number(pr), head_sha: view.headRefOid, base_sha: view.baseRefOid,
  mode: 'review', level: 'medium', model: null, engine: credential.engine, credential_kind: credential.kind, attempt: 1,
};
const result = await runJob(ctx, { job, installation_token: token, heartbeat_timeout_s: 300 });
process.stdout.write(`conclusion ${result.conclusion} exit ${result.exit}\nround ${kept}/round\n`);
