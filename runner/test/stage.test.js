import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseStageArgs, stage } from '../src/stage.js';

const SHA = 'a'.repeat(40);

it('parseStageArgs needs a repo, a PR and full shas (#184)', () => {
  assert.throws(() => parseStageArgs([]), /--repo/);
  assert.throws(() => parseStageArgs(['--repo', 'o/r', '--pr', '1', '--head-sha', 'abc']), /40-hex/);
  const o = parseStageArgs(['--repo', 'o/r', '--pr', '7', '--head-sha', SHA]);
  assert.deepEqual([o.cwd, o.out, o.mode], ['/checkout', '/round', 'review']);
});

it('stage checks out with the job token, builds the manifest and writes staged.json', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'stage-'));
  const calls = [];
  const staged = await stage({ repo: 'o/r', pr: '7', headSha: SHA, baseSha: null, mode: 'review', cwd: '/c', out }, {
    env: { GH_TOKEN: 'ghs_x' },
    doCheckout: async (a) => { calls.push(['checkout', a.token, a.dir]); },
    doManifest: async (a) => { calls.push(['manifest', a.ghToken, a.cwd]); return { manifest: { files: [{}, { filtered_by: 'x' }] }, diffBytes: 42, stderr: 'warn' }; },
  });
  assert.deepEqual(calls, [['checkout', 'ghs_x', '/c'], ['manifest', 'ghs_x', '/c']]);
  assert.equal(staged.files, 2);
  assert.equal(staged.reviewable, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'staged.json'), 'utf8')).diff_bytes, 42);
  assert.equal(readFileSync(path.join(out, 'manifest-stderr.log'), 'utf8'), 'warn');
});

it('stage refuses to run without a token', async () => {
  await assert.rejects(stage({ repo: 'o/r', pr: '7', headSha: SHA, out: '/tmp' }, { env: {} }), /GH_TOKEN/);
});
