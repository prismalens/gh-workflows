#!/usr/bin/env node
// One source of truth for the credential shapes. finding-tools.js imports looksLikeSecret
// directly; gh-shim.sh, which records from a shell, pipes the body in here instead of
// re-implementing the shapes in its python heredoc, where the two lists would drift.
// Exit 1 when the text carries a credential shape, 0 when it does not.
import { readFileSync } from 'node:fs';
import { looksLikeSecret } from './acp-map.js';

const text = readFileSync(0, 'utf8');
process.exit(looksLikeSecret(text) ? 1 : 0);
