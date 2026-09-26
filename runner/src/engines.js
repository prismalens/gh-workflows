// The engine registry: what to spawn and how it takes its model and credential. Every row is
// an ACP agent on stdio. A row enters only after an admission run passes; `admitted` records it.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Env is an allowlist per row, never the runner's whole environment (prismalens#169).
const BASE_ENV = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'NODE_OPTIONS'];

export const ENGINES = Object.freeze({
  opencode: {
    command: 'opencode',
    // --pure: no user plugins or global config; --cwd pins the project. Mirrors the prismalens
    // registry row that passed the #561 admission run.
    args: ({ cwd }) => ['acp', '--pure', '--cwd', cwd],
    envAllow: [...BASE_ENV, 'GH_TOKEN', 'GITHUB_TOKEN', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'],
    credentialKinds: ['api-key'],
    // Hosts the engine may CONNECT to beyond api.github.com (#184, spec Q2).
    egress: [],
    admitted: { version: '1.18.30', by: 'prismalens#561' },
    // OpenCode Zen's free tier needs no key or login. Of its free, non-deprecated, tool-calling
    // rows in the models.dev catalog on 2026-09-19, Muse Spark 1.3 (2026-09-02, 1M context) is
    // the newest; MiMo V2.5 and Nemotron 3 Ultra stalled on the lane's subagent plan.
    defaultModel: 'opencode/muse-spark-1.3-contributor-free',
    // The runner writes the engine's whole config per run: model, and the permission block
    // that makes OpenCode ask before an edit or a shell command so the ACP policy is the
    // answer. Without it OpenCode edits and runs without asking (verified 2026-09-19 on
    // 1.18.30: an edit, a delete and a redirect all landed with no request_permission).
    // The repo's own opencode.json and CLAUDE.md-style files stay inert.
    // With `proxy`, the model's provider points at the key proxy and its key is the round's nonce.
    prepare({ model, outDir, env, proxy = null }) {
      let provider = {};
      if (proxy) {
        const providerId = String(model ?? '').split('/')[0];
        if (!model || !String(model).includes('/') || !providerId) throw new Error(`opencode: model ${model} names no provider`);
        provider = { provider: { [providerId]: { options: { baseURL: proxy.baseURL, apiKey: proxy.token } } } };
      }
      const configDir = path.join(outDir, 'engine-config');
      const dataDir = path.join(outDir, 'engine-xdg');
      mkdirSync(configDir, { recursive: true }); mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        ...(model ? { model } : {}),
        permission: { edit: 'ask', bash: 'ask', webfetch: 'deny', websearch: 'deny', external_directory: 'deny' },
        // A refused tool would otherwise end the turn before the summary (prismalens#639 finding 1).
        experimental: { continue_loop_on_deny: true },
        share: 'disabled',
        ...provider,
      }, null, 2) + '\n');
      return {
        ...env, XDG_CONFIG_HOME: dataDir, OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
      };
    },
  },
  'claude-code': {
    command: 'claude-agent-acp',
    args: () => [],
    envAllow: [...BASE_ENV, 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL', 'CLAUDE_CODE_EXECUTABLE', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
    credentialKinds: ['api-key', 'bedrock', 'vertex', 'foundry'],
    egress: [],
    admitted: null, // prismalens#639 passes the gate; no admission record in this repo yet
    prepare({ model, env, proxy = null }) {
      const out = { ...env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ...(model ? { ANTHROPIC_MODEL: model } : {}) };
      if (proxy) {
        delete out.ANTHROPIC_AUTH_TOKEN;
        Object.assign(out, { ANTHROPIC_BASE_URL: proxy.baseURL, ANTHROPIC_API_KEY: proxy.token });
      }
      return out;
    },
  },
});

// `extraAllow` names one credential variable the daemon handed this round (--credential-env),
// so a key under a name of the operator's choosing reaches the engine and nothing else does.
export function engineEnv(row, source = process.env, extraAllow = []) {
  const out = {};
  for (const k of [...row.envAllow, ...extraAllow]) if (source[k] !== undefined) out[k] = source[k];
  return out;
}
