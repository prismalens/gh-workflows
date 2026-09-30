import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MintError } from "./github-app.js";
import { ConfigEditError, openConfigPullRequest, readConfigFile, validateConfigText } from "./config-edit.js";

const FILE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const CURRENT = "version: 1\nreview:\n  level: medium\n";

// A fake GitHub: routes are "METHOD path" -> [status, body]; every call is recorded.
function fakeGithub(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = String(url).replace("https://api.github.com", "");
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    const hit = routes[`${method} ${path}`];
    const [status, body] = hit ?? (method === "DELETE" ? [204, null] : [404, { message: "Not Found" }]);
    return new Response(body === null ? null : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

function fakeMint({ perms = { contents: "write", pull_requests: "write", metadata: "read" }, fail } = {}) {
  const minted = [];
  return {
    minted,
    mint: async (args) => {
      minted.push(args);
      if (fail) throw fail;
      return { token: "ghs_test", installation_permissions: perms };
    },
  };
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

describe("validateConfigText", () => {
  it("accepts a valid file and reads an unquoted off the way PyYAML does", () => {
    assert.deepEqual(validateConfigText("version: 1\nreview:\n  admission: off\n"), { ok: true, errors: [] });
  });

  it("names the key a rejected value sits on, and nothing above it", () => {
    assert.deepEqual(validateConfigText("version: 1\nreview:\n  level: low\n").errors, [
      'review/level: Instance does not match any of ["medium","high"].',
    ]);
    assert.deepEqual(validateConfigText("version: 1\nreview:\n  nope: 1\n").errors, [
      'review: Property "nope" does not match additional properties schema.',
    ]);
  });

  it("refuses YAML that does not parse, a missing version and an oversized file", () => {
    assert.equal(validateConfigText("review: [\n").ok, false);
    assert.equal(validateConfigText("review: {}\n").ok, false);
    assert.equal(validateConfigText(`version: 1\n# ${"x".repeat(70000)}\n`).ok, false);
  });
});

describe("readConfigFile", () => {
  it("returns the default branch's file, whether a PR can be opened, and revokes the token", async () => {
    const gh = fakeGithub({
      "GET /repos/o/r": [200, { default_branch: "main" }],
      "GET /repos/o/r/contents/.github/claude-review.yml?ref=main": [200, { sha: FILE_SHA, content: b64(CURRENT) }],
    });
    const m = fakeMint();
    const out = await readConfigFile({ repository: "o/r", mint: m.mint, fetch: gh.fetch });
    assert.deepEqual(out, {
      repository: "o/r",
      path: ".github/claude-review.yml",
      default_branch: "main",
      sha: FILE_SHA,
      content: CURRENT,
      can_open_pr: true,
    });
    assert.deepEqual(m.minted[0].permissions, { contents: "read", metadata: "read" });
    assert.equal(gh.calls.at(-1).method, "DELETE", "token revoked last");
  });

  it("returns a null file when there is none, and can_open_pr false on a read-only install", async () => {
    const gh = fakeGithub({ "GET /repos/o/r": [200, { default_branch: "trunk" }] });
    const out = await readConfigFile({
      repository: "o/r",
      mint: fakeMint({ perms: { contents: "read", pull_requests: "write" } }).mint,
      fetch: gh.fetch,
    });
    assert.equal(out.content, null);
    assert.equal(out.sha, null);
    assert.equal(out.can_open_pr, false);
  });

  it("refuses a repository that is not owner/repo, and maps not-installed to 404", async () => {
    for (const repository of [null, "o", "o/r/x", "../r", "o/.r"]) {
      await assert.rejects(
        readConfigFile({ repository, mint: fakeMint().mint, fetch: fakeGithub({}).fetch }),
        (e) => e instanceof ConfigEditError && e.code === "invalid-repository"
      );
    }
    await assert.rejects(
      readConfigFile({ repository: "o/r", mint: fakeMint({ fail: new MintError("not-installed", 404) }).mint, fetch: fakeGithub({}).fetch }),
      (e) => e.code === "not-installed" && e.status === 404
    );
  });
});

describe("openConfigPullRequest", () => {
  const routes = () => ({
    "GET /repos/o/r": [200, { default_branch: "main" }],
    "GET /repos/o/r/git/ref/heads/main": [200, { object: { sha: HEAD_SHA } }],
    "POST /repos/o/r/git/refs": [201, {}],
    "PUT /repos/o/r/contents/.github/claude-review.yml": [200, {}],
    "POST /repos/o/r/pulls": [201, { html_url: "https://github.com/o/r/pull/9", number: 9 }],
  });
  const next = "version: 1\nreview:\n  level: high\n";

  it("branches from the default head, changes only the config file, and opens the PR", async () => {
    const gh = fakeGithub(routes());
    const m = fakeMint();
    const out = await openConfigPullRequest({
      repository: "o/r",
      content: next,
      base_sha: FILE_SHA,
      summary: ["review.level: medium -> high"],
      mint: m.mint,
      fetch: gh.fetch,
      now: Date.UTC(2026, 8, 30, 21, 5, 9),
    });
    assert.deepEqual(out, { url: "https://github.com/o/r/pull/9", number: 9, branch: "assayer/config-20260930-210509" });
    assert.deepEqual(m.minted[0].permissions, { contents: "write", metadata: "read", pull_requests: "write" });
    const ref = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/git/refs"));
    assert.deepEqual(ref.body, { ref: "refs/heads/assayer/config-20260930-210509", sha: HEAD_SHA });
    const put = gh.calls.find((c) => c.method === "PUT");
    assert.equal(Buffer.from(put.body.content, "base64").toString("utf8"), next);
    assert.equal(put.body.sha, FILE_SHA);
    assert.equal(put.body.branch, "assayer/config-20260930-210509");
    const pr = gh.calls.find((c) => c.path.endsWith("/pulls"));
    assert.equal(pr.body.base, "main");
    assert.match(pr.body.title, /^chore: /);
    assert.match(pr.body.body, /- review\.level: medium -> high/);
    assert.equal(gh.calls.filter((c) => c.method === "PUT").length, 1, "one file write");
    assert.ok(!gh.calls.some((c) => c.method === "DELETE" && c.path.includes("/git/refs/")), "branch kept");
    assert.equal(gh.calls.at(-1).path, "/installation/token");
  });

  it("creates the file when there was none: no sha on the write", async () => {
    const gh = fakeGithub(routes());
    await openConfigPullRequest({ repository: "o/r", content: next, base_sha: null, mint: fakeMint().mint, fetch: gh.fetch });
    assert.equal("sha" in gh.calls.find((c) => c.method === "PUT").body, false);
  });

  it("refuses when the file changed since it was loaded, and deletes the branch it made", async () => {
    const r = routes();
    r["PUT /repos/o/r/contents/.github/claude-review.yml"] = [409, { message: "sha mismatch" }];
    const gh = fakeGithub(r);
    await assert.rejects(
      openConfigPullRequest({ repository: "o/r", content: next, base_sha: FILE_SHA, mint: fakeMint().mint, fetch: gh.fetch }),
      (e) => e.code === "config-changed" && e.status === 409
    );
    assert.ok(gh.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/repos/o/r/git/refs/heads/assayer/config-")));
    assert.equal(gh.calls.at(-1).path, "/installation/token");
  });

  it("refuses a schema-rejected file before minting anything", async () => {
    const m = fakeMint();
    await assert.rejects(
      openConfigPullRequest({ repository: "o/r", content: "version: 1\nreview:\n  level: low\n", base_sha: null, mint: m.mint, fetch: fakeGithub({}).fetch }),
      (e) => e.code === "schema-rejected" && e.extra.errors.length === 1
    );
    assert.equal(m.minted.length, 0);
  });

  it("maps an installation without contents: write to app-cannot-write", async () => {
    await assert.rejects(
      openConfigPullRequest({
        repository: "o/r",
        content: next,
        base_sha: null,
        mint: fakeMint({ fail: new MintError("github-error", 422) }).mint,
        fetch: fakeGithub({}).fetch,
      }),
      (e) => e.code === "app-cannot-write" && e.status === 409
    );
  });

  it("refuses a base_sha that is not a blob sha", async () => {
    await assert.rejects(
      openConfigPullRequest({ repository: "o/r", content: next, base_sha: "main", mint: fakeMint().mint, fetch: fakeGithub({}).fetch }),
      (e) => e.code === "invalid-base-sha"
    );
  });
});
