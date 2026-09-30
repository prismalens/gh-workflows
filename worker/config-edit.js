// The Console's config editor (#78): reads a repository's .github/claude-review.yml and opens a
// pull request that changes only that file. The file stays the only repo layer; nothing here
// stores config, and the lane still reads the file at each PR's base ref (#33).
import { Validator } from "@cfworker/json-schema";
import { parseDocument } from "yaml";

import { CONFIG_PR_TOKEN_PERMISSIONS, CONFIG_READ_TOKEN_PERMISSIONS, MintError } from "./github-app.js";
import { revokeToken } from "./poster.js";
import schema from "../tools/review-config/schema.json" with { type: "json" };

export const CONFIG_PATH = ".github/claude-review.yml";
const GITHUB_API = "https://api.github.com";
const MAX_CONFIG_BYTES = 64 * 1024;
const REPOSITORY_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

const validator = new Validator(schema, "2020-12", false);

export class ConfigEditError extends Error {
  constructor(code, status, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "assayer-control-plane",
    "Content-Type": "application/json",
  };
}

async function gh(fetchImpl, token, method, path, body) {
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    method,
    headers: githubHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

function splitRepository(repository) {
  if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
    throw new ConfigEditError("invalid-repository", 400);
  }
  const [owner, repo] = repository.split("/");
  return { owner, repo };
}

function mintError(e) {
  if (e instanceof MintError) {
    if (e.code === "not-installed") return new ConfigEditError("not-installed", 404);
    // GitHub answers 422 when a token asks for a permission the installation was not granted.
    if (e.status === 422) return new ConfigEditError("app-cannot-write", 409);
    return new ConfigEditError(e.code, 502);
  }
  return new ConfigEditError("mint-failed", 502);
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// The validator reports every enclosing schema that failed as well; keep the ones that name the
// actual key or value.
function leafErrors(errors) {
  const real = errors.filter((e) => !["properties", "items", "false"].includes(e.keyword));
  const leaves = real.filter(
    (e) =>
      e.keyword !== "additionalProperties" ||
      !real.some((o) => o !== e && o.instanceLocation.startsWith(`${e.instanceLocation}/`))
  );
  return [...new Set(leaves.map((e) => `${e.instanceLocation.replace(/^#\/?/, "") || "(file)"}: ${e.error}`))];
}

/**
 * Parses and validates a candidate file the way the lane will read it. YAML 1.1, because the lane
 * reads with PyYAML, where an unquoted `off` is false.
 */
export function validateConfigText(text) {
  if (typeof text !== "string") return { ok: false, errors: ["content must be a string"] };
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    return { ok: false, errors: [`content is over ${MAX_CONFIG_BYTES} bytes`] };
  }
  const doc = parseDocument(text, { version: "1.1" });
  if (doc.errors.length) return { ok: false, errors: doc.errors.map((e) => e.message) };
  const result = validator.validate(doc.toJS() ?? {});
  if (!result.valid) return { ok: false, errors: leafErrors(result.errors) };
  return { ok: true, errors: [] };
}

/** The file on the default branch, and whether the App could open a pull request that changes it. */
export async function readConfigFile({ repository, mint, fetch: fetchImpl }) {
  const { owner, repo } = splitRepository(repository);
  let minted;
  try {
    minted = await mint({ owner, repo, permissions: CONFIG_READ_TOKEN_PERMISSIONS });
  } catch (e) {
    throw mintError(e);
  }
  const { token, installation_permissions: perms = {} } = minted;
  try {
    const meta = await gh(fetchImpl, token, "GET", `/repos/${owner}/${repo}`);
    if (!meta.ok) throw new ConfigEditError("github-error", 502, { github_status: meta.status });
    const branch = meta.json.default_branch;
    const file = await gh(
      fetchImpl,
      token,
      "GET",
      `/repos/${owner}/${repo}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(branch)}`
    );
    if (file.status !== 404 && !file.ok) throw new ConfigEditError("github-error", 502, { github_status: file.status });
    return {
      repository,
      path: CONFIG_PATH,
      default_branch: branch,
      sha: file.ok ? file.json.sha : null,
      content: file.ok ? base64ToUtf8(file.json.content) : null,
      can_open_pr: perms.contents === "write" && perms.pull_requests === "write",
    };
  } finally {
    await revokeToken(fetchImpl, token);
  }
}

function branchStamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}

/**
 * Opens a pull request whose only change is the config file. `base_sha` is the file's blob sha
 * the editor loaded (null when there was no file), so an edit made meanwhile on GitHub refuses
 * instead of being overwritten.
 */
export async function openConfigPullRequest({ repository, content, base_sha, summary, mint, fetch: fetchImpl, now = Date.now() }) {
  const { owner, repo } = splitRepository(repository);
  if (base_sha !== null && !(typeof base_sha === "string" && SHA_RE.test(base_sha))) {
    throw new ConfigEditError("invalid-base-sha", 400);
  }
  const checked = validateConfigText(content);
  if (!checked.ok) throw new ConfigEditError("schema-rejected", 400, { errors: checked.errors });
  const lines = Array.isArray(summary) ? summary.filter((s) => typeof s === "string").slice(0, 50) : [];

  let token;
  try {
    ({ token } = await mint({ owner, repo, permissions: CONFIG_PR_TOKEN_PERMISSIONS }));
  } catch (e) {
    throw mintError(e);
  }
  const branch = `assayer/config-${branchStamp(now)}`;
  let branchCreated = false;
  try {
    const meta = await gh(fetchImpl, token, "GET", `/repos/${owner}/${repo}`);
    if (!meta.ok) throw new ConfigEditError("github-error", 502, { github_status: meta.status });
    const base = meta.json.default_branch;
    const head = await gh(fetchImpl, token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    if (!head.ok) throw new ConfigEditError("github-error", 502, { github_status: head.status });

    const ref = await gh(fetchImpl, token, "POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: head.json.object.sha,
    });
    if (!ref.ok) throw new ConfigEditError("github-error", 502, { github_status: ref.status });
    branchCreated = true;

    const put = await gh(fetchImpl, token, "PUT", `/repos/${owner}/${repo}/contents/${CONFIG_PATH}`, {
      message: "chore: review config from the Assayer Console",
      content: utf8ToBase64(content),
      branch,
      ...(base_sha ? { sha: base_sha } : {}),
    });
    // 409 when the sha is stale; 422 when a sha was needed (the file appeared) or given for none.
    if (put.status === 409 || put.status === 422) throw new ConfigEditError("config-changed", 409);
    if (!put.ok) throw new ConfigEditError("github-error", 502, { github_status: put.status });

    const body = [
      "Opened from the Assayer Console's config editor. It changes only `" + CONFIG_PATH + "`.",
      "",
      ...(lines.length ? ["Changed keys:", ...lines.map((l) => `- ${l}`), ""] : []),
      "The lane reads this file at each pull request's base ref, so the change applies to reviews once this merges.",
    ].join("\n");
    const pr = await gh(fetchImpl, token, "POST", `/repos/${owner}/${repo}/pulls`, {
      title: "chore: review config from the Assayer Console",
      head: branch,
      base,
      body,
    });
    if (!pr.ok) throw new ConfigEditError("github-error", 502, { github_status: pr.status });
    branchCreated = false;
    return { url: pr.json.html_url, number: pr.json.number, branch };
  } finally {
    if (branchCreated) {
      await gh(fetchImpl, token, "DELETE", `/repos/${owner}/${repo}/git/refs/heads/${branch}`).catch(() => null);
    }
    await revokeToken(fetchImpl, token);
  }
}
