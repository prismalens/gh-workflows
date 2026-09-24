#!/usr/bin/env node
// Render the lane's prompt template for one round, computing the round-type tokens the way
// the workflow's build-prompt env block does. Prints the prompt on stdout, the prompt hash on
// stderr. Usage: render-prompt.mjs --repo owner/name --pr N [--level medium|high]
//   [--mode review|review-full|incremental --range-base SHA --range-head SHA] [--path-instructions]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPrompt, promptHash, laneTokens } from '../src/prompt.js';

const args = process.argv.slice(2);
const get = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const repo = get('--repo'); const pr = get('--pr');
if (!repo || !pr || !/^[^/]+\/[^/]+$/.test(repo) || !/^\d+$/.test(pr)) { console.error('usage: --repo owner/name --pr N'); process.exit(2); }
const level = get('--level', 'medium'); const mode = get('--mode', 'review');
if (!['review', 'review-full', 'incremental'].includes(mode)) { console.error('bad --mode'); process.exit(2); }
const rb = get('--range-base'); const rh = get('--range-head');
if (mode === 'incremental' && !(rb && rh)) { console.error('incremental needs --range-base and --range-head'); process.exit(2); }
const tokens = laneTokens({ repo, pr, level, mode, rangeBase: rb, rangeHead: rh, pathInstructions: has('--path-instructions') });
const template = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompt', 'template.md'), 'utf8');
const out = renderPrompt(template, tokens);
if (/@@[A-Z0-9_]+@@/.test(out)) { console.error('render left a placeholder: ' + out.match(/@@[A-Z0-9_]+@@/g).join(' ')); process.exit(1); }
process.stderr.write(`prompt_hash=${promptHash(template)}\n`);
process.stdout.write(out);
