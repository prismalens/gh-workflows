import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'finding-tools.js');

it('the recorder redacts credential-shaped verdict evidence before it reaches disk', async () => {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'assayer-ft-')), 'tool-log.jsonl');
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, 'assayer_verify'], env: { ...process.env, ASSAYER_TOOL_LOG: log } }));
  try {
    await client.callTool({ name: 'thread_verdict', arguments: { thread_id: 'T', path: 'p', verdict: 'fixed', sha: 'a'.repeat(7), evidence: `saw ghp_${'x'.repeat(36)}` } });
  } finally {
    await client.close();
  }
  const [entry] = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entry.input.evidence, null);
  assert.equal(entry.redacted, 'credential-shaped body');
  assert.doesNotMatch(readFileSync(log, 'utf8'), /ghp_/);
});
