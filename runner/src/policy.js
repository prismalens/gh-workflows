// The lane's --allowed-tools list, as an ACP permission policy. The list is load-bearing in
// the Actions lane (prismalens/prismalens#403); here it is the answer to every
// session/request_permission. `gh pr review` is deliberately absent. No unrestricted shell.

export const LANE_ALLOWED_TOOLS = Object.freeze([
  'Task', 'Read', 'Grep', 'Glob', 'LS',
  'Bash(gh pr diff:*)', 'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr comment:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh search:*)',
  'mcp__github_comment__update_claude_comment',
  'mcp__github_inline_comment__create_inline_comment',
]);

const COMMAND_PREFIXES = LANE_ALLOWED_TOOLS
  .filter((t) => t.startsWith('Bash('))
  .map((t) => t.slice(5, -3));

export const FINDING_TOOL = 'create_inline_comment';
export const SUMMARY_TOOL = 'update_claude_comment';

// ACP tool kinds the lane's read-only tools map onto.
const READ_KINDS = new Set(['read', 'search', 'think']);

export function commandAllowed(command) {
  // A stderr redirect to /dev/null or to stdout changes nothing the lane cares about; strip
  // those two forms, then refuse any other chaining, substitution or redirection. A pipe into
  // `head` is refused as the lane's own matcher would refuse it: every part must be allowed.
  const raw = String(command || '');
  // A newline or carriage return is a command separator to the shell; refuse every control
  // character before anything is normalised, so the first line can never vouch for a second.
  if (/[\x00-\x1f\x7f]/.test(raw.replace(/[ \t]/g, ''))) return false;
  const c = raw.trim().replace(/\s+2>\s*(\/dev\/null|&1)\b/g, '').replace(/\s+/g, ' ');
  if (/[;&|`$><]/.test(c)) return false;
  return COMMAND_PREFIXES.some((p) => c === p || c.startsWith(p + ' '));
}

function commandOf(toolCall) {
  const ri = toolCall.rawInput;
  if (ri && typeof ri === 'object') {
    for (const k of ['command', 'cmd', 'input']) if (typeof ri[k] === 'string') return ri[k];
  }
  return null;
}

// Decide once per request. Returns {allow, reason}.
export function decide(toolCall) {
  const kind = toolCall.kind || 'other';
  const name = String(toolCall.name || toolCall.title || '');
  if (name.endsWith(FINDING_TOOL) || name.endsWith(SUMMARY_TOOL)) return { allow: true, reason: 'comment tool' };
  if (READ_KINDS.has(kind)) return { allow: true, reason: `kind ${kind}` };
  if (kind === 'execute') {
    const cmd = commandOf(toolCall);
    if (cmd !== null && commandAllowed(cmd)) return { allow: true, reason: 'allowed gh command' };
    return { allow: false, reason: cmd === null ? 'execute without a command' : 'command outside the allowlist' };
  }
  return { allow: false, reason: `kind ${kind}` };
}

// Pick the option the agent offered that matches the decision. Prefer the *_once forms so a
// grant never outlives one call.
export function chooseOption(options, allow) {
  const want = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const k of want) {
    const o = options.find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return null;
}
