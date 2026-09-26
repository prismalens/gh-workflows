// The image pin is a hash of everything the image is built from (#184, spec Q3). The daemon compares
// it with the built image's label, so a job never runs bits this checkout does not describe.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const INPUTS = ['image/Dockerfile', 'image/entrypoint.sh', 'package.json', 'package-lock.json'];
const TREES = ['src', 'prompt'];

function walk(root, rel, out) {
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const child = path.posix.join(rel, name);
    if (statSync(path.join(root, child)).isDirectory()) walk(root, child, out);
    else out.push(child);
  }
}

export function imageInputs(root) {
  const files = [...INPUTS];
  for (const t of TREES) walk(root, t, files);
  return files.sort();
}

export function imageInputHash(root) {
  const h = createHash('sha256');
  for (const rel of imageInputs(root)) {
    h.update(rel).update('\0').update(readFileSync(path.join(root, rel))).update('\0');
  }
  return h.digest('hex');
}

export function imageTag(hash) {
  return `assayer-runner:${hash.slice(0, 12)}`;
}
