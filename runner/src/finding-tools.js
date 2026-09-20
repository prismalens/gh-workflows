#!/usr/bin/env node
// The lane's two comment tools, as one stdio MCP server the runner offers in session/new.
// Nothing is posted: each call is appended as a JSON line to $ASSAYER_TOOL_LOG and the
// engine is told it succeeded. The poster in the control plane renders them later.
// Server name is argv[2]: `github_inline_comment` serves create_inline_comment,
// `github_comment` serves update_claude_comment, so the engine sees the same
// mcp__<server>__<tool> names the Actions lane's prompt uses.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { looksLikeSecret } from './acp-map.js';

const which = process.argv[2];
const log = process.env.ASSAYER_TOOL_LOG;
if (!which || !log) {
  process.stderr.write('usage: finding-tools.js <github_inline_comment|github_comment>, with ASSAYER_TOOL_LOG set\n');
  process.exit(2);
}

function record(tool, input) {
  // Redact before the write, not after: SessionMapper filters when it reads this log back, by
  // which time an unredacted body is already on disk for anyone who collects it (CWE-532).
  const secret = typeof input?.body === 'string' && looksLikeSecret(input.body);
  const entry = secret ? { ...input, body: null } : input;
  appendFileSync(log, JSON.stringify({
    at: new Date().toISOString(), server: which, tool, input: entry,
    ...(secret ? { redacted: 'credential-shaped body' } : {}),
  }) + '\n');
}

const server = new McpServer({ name: which, version: '0.0.0' });

if (which === 'github_inline_comment') {
  server.registerTool('create_inline_comment', {
    description: 'Create an inline review comment on a specific line or range of the pull request diff.',
    inputSchema: {
      path: z.string(),
      body: z.string(),
      line: z.number().int().optional(),
      startLine: z.number().int().optional(),
      side: z.enum(['LEFT', 'RIGHT']).optional(),
      startSide: z.enum(['LEFT', 'RIGHT']).optional(),
      subjectType: z.string().optional(),
      commitId: z.string().optional(),
    },
  }, async (input) => {
    record('create_inline_comment', input);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, recorded: true }) }] };
  });
} else if (which === 'github_comment') {
  server.registerTool('update_claude_comment', {
    description: 'Update the review summary comment with the given body.',
    inputSchema: { body: z.string() },
  }, async (input) => {
    record('update_claude_comment', input);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, recorded: true }) }] };
  });
} else {
  process.stderr.write(`finding-tools: unknown server ${which}\n`);
  process.exit(2);
}

await server.connect(new StdioServerTransport());
