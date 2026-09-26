#!/usr/bin/env node
// Builds the job image from this checkout and tags it by input hash (#184, spec Q3).
// Usage: node scripts/build-image.mjs [--runtime podman|docker]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageInputHash, imageTag } from '../src/image-hash.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--runtime');
const onPath = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
const runtime = i > -1 ? process.argv[i + 1] : onPath('podman') ? 'podman' : 'docker';
if (!['podman', 'docker'].includes(runtime)) throw new Error(`build-image: unknown runtime ${runtime}`);

const hash = imageInputHash(root);
const tag = imageTag(hash);
const build = spawnSync(runtime, ['build', '--label', `assayer.input_sha256=${hash}`, '-t', tag, '-f', 'image/Dockerfile', '.'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const id = spawnSync(runtime, ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' }).stdout.trim();
process.stdout.write(`${tag} ${id}\n`);
