import { it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageInputHash, imageInputs, imageTag } from '../src/image-hash.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

it('hashes the Dockerfile, entrypoint, src, prompt and lockfile, and changes when any of them does (#184)', () => {
  const inputs = imageInputs(root);
  for (const f of ['image/Dockerfile', 'image/entrypoint.sh', 'package-lock.json', 'src/key-proxy.js', 'prompt/template.md']) {
    assert.ok(inputs.includes(f), f);
  }
  assert.ok(!inputs.some((f) => f.startsWith('test/')), 'tests are not image inputs');

  const copy = mkdtempSync(path.join(tmpdir(), 'img-'));
  for (const d of ['image', 'src', 'prompt']) cpSync(path.join(root, d), path.join(copy, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) cpSync(path.join(root, f), path.join(copy, f));
  const before = imageInputHash(copy);
  assert.equal(before, imageInputHash(root));
  writeFileSync(path.join(copy, 'src', 'probe.js'), '// changed\n', { flag: 'a' });
  assert.notEqual(imageInputHash(copy), before);
  assert.match(imageTag(before), /^assayer-runner:[0-9a-f]{12}$/);
});
