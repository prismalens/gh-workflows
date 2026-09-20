import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../src/manifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PY = path.join(HERE, '..', 'src', 'manifest.py');

// (a) manifest.py -- the two workflow steps copied verbatim -- is at least valid Python.
test('manifest.py parses', () => {
  execFileSync('python3', ['-m', 'py_compile', MANIFEST_PY]);
});

// (b) the wrapper validates cwd and repo BEFORE spawning anything, so a malformed value never
// reaches `gh`. No network, no python3, no child process for either case.
test('rejects a malformed REPO without spawning gh', async () => {
  await assert.rejects(
    buildManifest({ cwd: HERE, repo: 'not-owner-slash-name', pr: 1 }),
    /repo/i,
  );
  await assert.rejects(
    buildManifest({ cwd: HERE, repo: 'owner/name/extra', pr: 1 }),
    /repo/i,
  );
  await assert.rejects(
    buildManifest({ cwd: HERE, repo: '', pr: 1 }),
    /repo/i,
  );
});

test('rejects a cwd that is not a directory without spawning gh', async () => {
  await assert.rejects(
    buildManifest({ cwd: path.join(HERE, 'does-not-exist-at-all'), repo: 'prismalens/sreforge', pr: 1 }),
    /is not a directory/,
  );
  await assert.rejects(
    // A file, not a directory.
    buildManifest({ cwd: path.join(HERE, 'manifest.test.js'), repo: 'prismalens/sreforge', pr: 1 }),
    /is not a directory/,
  );
});

test('rejects a missing pr', async () => {
  await assert.rejects(
    buildManifest({ cwd: HERE, repo: 'prismalens/sreforge' }),
    /pr is required/,
  );
});

// (c) skipped: the manifest entry construction, the filtered_by decision, and the diff hunk
// filtering all live inline in the `for item in files_data:` loop body of
// build_review_manifest() in the ORIGINAL workflow step -- none of them is a standalone
// function there. Pulling any one of them out into a separately callable function would mean
// restructuring that copied loop body, which is exactly the rewrite the task (and the
// "wrap, do not rewrite" instruction for manifest.py) says not to do. The one already-standalone
// helper, matches_pattern(), is nested inside build_review_manifest()'s own local scope in the
// original step and is not importable without either calling the whole step (which needs `gh`
// and a live PR) or lifting it out of that scope -- the same rewrite this skips.
