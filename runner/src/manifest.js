#!/usr/bin/env node
// Wraps runner/src/manifest.py -- the review lane's "Build review manifest" and "Build review
// context" steps (claude-code-review.yml, ids `manifest` and `context`), extracted verbatim.
// Spawns python3 against a checkout with the same env vars those two steps set, then reads back
// the .claude-review-manifest.json and .claude-review.diff the script wrote into that checkout.
import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PY = path.join(HERE, 'manifest.py');

// Defaults, and where each one comes from:
//   mode              -- not a workflow config value; 'review' is this wrapper's and the CLI's
//                         own default (matches steps.mode.outputs.mode in the pull_request/push
//                         steady state, and the CLI usage the task describes: `[--mode review]`).
//   pathFilters       -- claude-code-review.yml's `config` step initializes `path_filters = []`
//                         (~line 466) as the "no override" sentinel and emits it verbatim via
//                         `json.dumps(path_filters)` (~line 1144); manifest.py's own
//                         DEFAULT_PATH_FILTERS list applies whenever the source is "workflow
//                         default", so '[]' reproduces that.
//   configResolution  -- the same `config` step's `sources` dict defaults every key to
//                         "workflow default" (~lines 488-504) before `config_resolution =
//                         json.dumps({"sources": sources, "layers": layers})` (~line 1081); '{}'
//                         reads the same way through manifest.py's own `config_res.get("sources",
//                         {}).get(key, "workflow default")` fallback.
//   maxReviewableLines-- workflow_call `inputs.max_reviewable_lines.default` (~line 51): 6000.
//   maxFileLines      -- workflow_call `inputs.max_file_lines.default` (~line 65): 2000.
//   contextLines      -- with no `review.context` repositories declared, the "Context checkout"
//                         step either does not run or writes `context_lines=0`; manifest.py's own
//                         `as_int(..., 0)` fallback agrees, so '0' is used directly.
//   languageMap       -- `config` step's `language_map = {}` sentinel (~line 474); manifest.py's
//                         own DEFAULT_LANGUAGE_MAP applies whenever the source stays "workflow
//                         default", so '{}' reproduces that (passed via extraEnv.LANGUAGE_MAP).
//   toolFindings      -- `config` step's `tool_findings_tools = []` sentinel (~line 475);
//                         manifest.py's own DEFAULT_TOOLS list (actionlint, shellcheck, tsc,
//                         eslint, biome) applies the same way (extraEnv.TOOL_FINDINGS).
//   issueByteBudget / issueTotalByteBudget
//                     -- workflow_call `inputs.issue_context_byte_budget.default` (~line 79,
//                        2000) and `inputs.issue_context_total_byte_budget.default` (~line 86,
//                        8000) (extraEnv.ISSUE_BYTE_BUDGET / extraEnv.ISSUE_TOTAL_BYTE_BUDGET).
// BASE_SHA, BASE_PR_NUMBER and BASE_PR_TITLE (build_review_context()'s own env vars, sourced from
// `needs.resolve.outputs.*` in the workflow, not from the `config` step) have no documented
// workflow default; they default to '' here, matching each one's own `os.environ.get(KEY, "")`
// inside manifest.py.
const DEFAULTS = {
  mode: 'review',
  pathFilters: '[]',
  configResolution: '{}',
  maxReviewableLines: '6000',
  maxFileLines: '2000',
  contextLines: '0',
  languageMap: '{}',
  toolFindings: '[]',
  issueByteBudget: '2000',
  issueTotalByteBudget: '8000',
};

export async function buildManifest({
  cwd,
  repo,
  pr,
  mode = DEFAULTS.mode,
  headSha = '',
  ghToken,
  pathFilters = DEFAULTS.pathFilters,
  configResolution = DEFAULTS.configResolution,
  maxReviewableLines = DEFAULTS.maxReviewableLines,
  maxFileLines = DEFAULTS.maxFileLines,
  contextLines = DEFAULTS.contextLines,
  extraEnv = {},
} = {}) {
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`buildManifest: cwd ${JSON.stringify(cwd)} is not a directory`);
  }
  // Same shape gh itself expects for `repos/{repo}/...`: exactly one slash, non-empty on both
  // sides, no whitespace. Checked here so a malformed REPO never reaches a `gh api` call.
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`buildManifest: repo ${JSON.stringify(repo)} must look like owner/name`);
  }
  if (pr === undefined || pr === null || String(pr).trim() === '') {
    throw new Error('buildManifest: pr is required');
  }

  const env = {
    ...process.env,
    GH_TOKEN: ghToken ?? process.env.GH_TOKEN ?? '',
    REPO: repo,
    PR: String(pr),
    MODE: mode,
    HEAD_SHA: headSha,
    PATH_FILTERS: pathFilters,
    CONFIG_RESOLUTION: configResolution,
    MAX_REVIEWABLE_LINES: String(maxReviewableLines),
    MAX_FILE_LINES: String(maxFileLines),
    CONTEXT_LINES: String(contextLines),
    // build_review_context()'s own env vars; see the DEFAULTS comment above for why each one
    // defaults the way it does. A caller overrides any of these through extraEnv.
    BASE_SHA: '',
    LANGUAGE_MAP: DEFAULTS.languageMap,
    TOOL_FINDINGS: DEFAULTS.toolFindings,
    ISSUE_BYTE_BUDGET: DEFAULTS.issueByteBudget,
    ISSUE_TOTAL_BYTE_BUDGET: DEFAULTS.issueTotalByteBudget,
    BASE_PR_NUMBER: '',
    BASE_PR_TITLE: '',
    GITHUB_WORKSPACE: cwd,
    ...extraEnv,
  };
  // manifest.py relays GITHUB_OUTPUT to stderr itself when the var is unset (see its module
  // docstring); a leftover GITHUB_OUTPUT inherited from this process's own environment would
  // instead make it write into a file this wrapper never reads, silently.
  delete env.GITHUB_OUTPUT;

  const { code, stderr, signal } = await new Promise((resolve, reject) => {
    const child = spawn('python3', [MANIFEST_PY], { cwd, env });
    let stderrBuf = '';
    child.stderr.on('data', (d) => { stderrBuf += d; });
    child.stdout.resume(); // manifest.py's own progress prints; not parsed here
    child.on('error', (e) => reject(new Error(`buildManifest: failed to spawn python3: ${e.message}`)));
    child.on('exit', (code, signal) => resolve({ code, stderr: stderrBuf, signal }));
  });
  if (code !== 0) {
    throw new Error(`buildManifest: manifest.py exited ${code}${signal ? ` (signal ${signal})` : ''}\n${stderr}`);
  }

  const manifestPath = path.join(cwd, '.claude-review-manifest.json');
  const diffPath = path.join(cwd, '.claude-review.diff');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`buildManifest: could not read/parse ${manifestPath}: ${e.message}\n${stderr}`);
  }
  let diffBytes;
  try {
    diffBytes = statSync(diffPath).size;
  } catch (e) {
    throw new Error(`buildManifest: could not stat ${diffPath}: ${e.message}\n${stderr}`);
  }

  return { manifest, diffBytes, stderr };
}

function parseCliArgs(argv) {
  const o = { mode: 'review' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const v = argv[i + 1];
    const need = () => { if (v === undefined) throw new Error(`${a} needs a value`); i += 1; return v; };
    if (a === '--cwd') o.cwd = need();
    else if (a === '--repo') o.repo = need();
    else if (a === '--pr') o.pr = need();
    else if (a === '--mode') o.mode = need();
    else if (a === '--head-sha') o.headSha = need();
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['cwd', 'repo', 'pr']) if (!o[k]) throw new Error(`--${k} is required`);
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseCliArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`manifest: ${e.message}\n`); process.exit(2); }
  buildManifest({
    cwd: path.resolve(opts.cwd), repo: opts.repo, pr: opts.pr, mode: opts.mode, headSha: opts.headSha,
    ghToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  }).then(({ manifest, diffBytes, stderr }) => {
    if (stderr && stderr.trim()) process.stderr.write(stderr);
    const files = manifest.files ?? [];
    const filteredBy = {};
    let reviewable = 0;
    for (const f of files) {
      if (f.filtered_by) filteredBy[f.filtered_by] = (filteredBy[f.filtered_by] ?? 0) + 1;
      else reviewable += 1;
    }
    const contextKeys = Object.keys(manifest.context ?? {});
    process.stdout.write(
      `manifest: ${files.length} file(s), ${reviewable} reviewable, `
      + `filtered_by=${JSON.stringify(filteredBy)}, diff=${diffBytes} byte(s), `
      + `context keys=[${contextKeys.join(', ')}]\n`,
    );
  }).catch((e) => { process.stderr.write(`manifest: ${e.message}\n`); process.exit(1); });
}
