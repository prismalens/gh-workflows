import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LIVENESS_PREFIX, livenessBody, looksLikeSecret, postRound, quiet, roundVerdict, upsertLiveness } from "./poster.js";

const APP = "assayer-review-dev[bot]";
const HEAD = "b".repeat(40);
const JOB = { id: "j", repository: "prismalens/sreforge", pr_number: 183, head_sha: HEAD, engine: "opencode", model: "opencode/muse" };

function github({ comments = [], refuse = new Set() } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body, auth: init.headers?.Authorization });
    if (method === "GET" && u.pathname.endsWith("/comments")) {
      return new Response(JSON.stringify(comments), { status: 200 });
    }
    if (refuse.has(body?.path)) {
      return new Response("{}", { status: 422 });
    }
    return new Response("{}", { status: method === "POST" ? 201 : 200 });
  };
  return { fetch, calls };
}

const envelope = "_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_\n\nbody";
const finding = (over = {}) => ({ v: "assayer/v1", type: "finding", path: "src/a.js", line: 12, side: "RIGHT", body: envelope, ...over });
const stream = (extra = []) => [
  { type: "started", engine: "opencode", model: "opencode/muse", _meta: { served_model: "opencode/muse-2" } },
  ...extra,
  { type: "summary", header: "## Code review", body: "## Code review\n\nOne issue." },
  { type: "finished", conclusion: "completed", _meta: { token_revoked: true } },
];

describe("poster (#184)", () => {
  it("posts each finding as a review comment on the head, the summary as an issue comment, then its liveness", async () => {
    const gh = github();
    const r = await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, events: stream([finding(), finding({ line: 20, _meta: { start_line: 18 } })]), rounds: 1 });
    assert.deepEqual(r, { inline: 2, refused: 0, summary: 1, unplaced: 0 });
    const writes = gh.calls.filter((c) => c.method !== "GET");
    assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), [
      "POST /repos/prismalens/sreforge/pulls/183/comments",
      "POST /repos/prismalens/sreforge/pulls/183/comments",
      "POST /repos/prismalens/sreforge/issues/183/comments",
      "POST /repos/prismalens/sreforge/issues/183/comments",
    ]);
    assert.deepEqual(writes[0].body, {
      body: `${envelope}\n\n<!-- assayer-finding engine=opencode -->`,
      commit_id: HEAD,
      path: "src/a.js",
      line: 12,
      side: "RIGHT",
    });
    assert.equal(writes[1].body.start_line, 18);
    assert.ok(writes[3].body.body.startsWith(`${LIVENESS_PREFIX} rounds=1 sha=${HEAD} engine=opencode -->`));
    assert.match(writes[3].body.body, /opencode\/muse-2\): reviewed `bbbbbbb`, 2 findings inline\./);
  });

  it("stamps the engine marker the sweep reads only for an engine of the registry's shape (#184)", async () => {
    const gh = github();
    await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: { ...JOB, engine: "Bad Engine -->" }, events: stream([finding()]), rounds: 1 });
    const inline = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls/183/comments"));
    assert.equal(inline.body.body, envelope);
  });

  it("never calls POST /pulls/:n/reviews, so a round can neither approve nor block", async () => {
    const gh = github();
    await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, events: stream([finding()]), rounds: 1 });
    assert.ok(gh.calls.every((c) => !/\/pulls\/\d+\/reviews/.test(c.path)));
  });

  it("refuses a finding with a credential-shaped body, no line, or a path outside the checkout, and counts a 422", async () => {
    const gh = github({ refuse: new Set(["gone.js"]) });
    const r = await postRound({
      fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, rounds: 1,
      events: stream([
        finding({ body: `leak ghp_${"a".repeat(36)}` }),
        finding({ line: null }),
        finding({ _meta: { path_outside_checkout: true } }),
        finding({ path: "gone.js" }),
        finding(),
      ]),
    });
    assert.deepEqual(r, { inline: 1, refused: 4, summary: 1, unplaced: 3 });
  });

  it("never says no findings when every finding failed to anchor, and posts each one as a comment (OBJ-005)", async () => {
    const gh = github({ refuse: new Set(["src/a.js"]) });
    const r = await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, events: stream([finding(), finding({ line: 30 })]), rounds: 1 });
    assert.deepEqual(r, { inline: 0, refused: 2, summary: 1, unplaced: 2 });
    const issueWrites = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues/183/comments"));
    assert.equal(issueWrites.length, 4);
    assert.match(issueWrites[1].body.body, /^\*\*Not placed inline\*\* \(`src\/a\.js:12`\)/);
    assert.match(issueWrites[2].body.body, /`src\/a\.js:30`/);
    assert.match(issueWrites[3].body.body, /reviewed `bbbbbbb`, 0 findings inline, 2 not placed inline \(posted as comments\)\./);
    assert.doesNotMatch(issueWrites[3].body.body, /no findings/);
  });

  it("screens the location of an unplaced finding, not only its body", async () => {
    const gh = github();
    const r = await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, rounds: 1,
      events: stream([finding({ path: `ghp_${"a".repeat(36)}`, _meta: { path_outside_checkout: true } })]) });
    assert.equal(r.unplaced, 0);
    assert.ok(gh.calls.every((c) => !JSON.stringify(c.body ?? "").includes("ghp_")));
  });

  it("does not rewrite liveness on a replayed publish or when told to skip it", async () => {
    const seen = new Map([["finding:0", 1], ["summary", 2], ["liveness", null]]);
    const journal = { has: (k) => seen.has(k), record: (k, id) => seen.set(k, id) };
    const gh = github();
    await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, events: stream([finding()]), rounds: 1, journal });
    assert.deepEqual(gh.calls, []);
    const fresh = github();
    await postRound({ fetch: fresh.fetch, token: "t", appLogin: APP, job: JOB, events: stream([finding()]), rounds: 1, skipLiveness: true });
    assert.ok(fresh.calls.every((c) => !c.path.endsWith("/issues/comments") && c.method !== "PATCH"));
    assert.equal(fresh.calls.filter((c) => c.method === "POST").length, 2);
  });

  it("resumes from a journal without posting a recorded finding or summary twice (OBJ-006)", async () => {
    const seen = new Map([["finding:0", 11], ["summary", 12]]);
    const journal = { has: (k) => seen.has(k), record: (k, id) => seen.set(k, id) };
    const gh = github();
    const r = await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, events: stream([finding(), finding({ line: 20 })]), rounds: 1, journal });
    assert.deepEqual(r, { inline: 2, refused: 0, summary: 1, unplaced: 0 });
    const writes = gh.calls.filter((c) => c.method !== "GET");
    assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), [
      "POST /repos/prismalens/sreforge/pulls/183/comments",
      "POST /repos/prismalens/sreforge/issues/183/comments",
    ]);
    assert.equal(writes[0].body.line, 20);
    assert.ok(seen.has("finding:1") && seen.has("liveness"));
  });

  it("never @-mentions from a posted body, so a quoted summons cannot start a lane (OBJ-023)", async () => {
    assert.equal(quiet("run @claude review now"), "run @\u200dclaude review now");
    assert.equal(quiet("a@ b"), "a@ b");
    const gh = github({ refuse: new Set(["src/a.js"]) });
    await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, rounds: 1,
      events: stream([finding({ body: "_x_\n\n@claude review" }), finding({ path: "src/b.js", body: "see @claude" })]) });
    assert.ok(gh.calls.filter((c) => c.method === "POST").every((c) => !/@claude/.test(c.body.body)));
  });

  it("leaves code spans and fences byte-exact when it quiets mentions (OBJ-027)", () => {
    const body = "ping @claude\n\n```suggestion\nimport x from \"@scope/pkg\";\n@decorator\n```\nand `@Inject` here";
    const q = quiet(body);
    assert.match(q, /ping @\u200dclaude/);
    assert.ok(q.includes('import x from "@scope/pkg";\n@decorator\n```'));
    assert.ok(q.includes("`@Inject`"));
  });

  it("ends every comment a round posts in the engine marker, so a stub can divert it (OBJ-020)", async () => {
    const gh = github({ refuse: new Set(["src/a.js"]) });
    await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, rounds: 1, events: stream([finding()]) });
    const posts = gh.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 4); // refused inline attempt, summary, fallback, liveness
    assert.ok(posts.every((c) => c.body.body.endsWith("<!-- assayer-finding engine=opencode -->")));
  });

  it("does not retry inline a finding already delivered as a fallback (OBJ-006)", async () => {
    const seen = new Map([["unplaced:0", 5]]);
    const journal = { has: (k) => seen.has(k), record: (k, id) => seen.set(k, id) };
    const gh = github();
    await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, rounds: 1, journal, events: stream([finding()]) });
    assert.ok(gh.calls.every((c) => !c.path.endsWith("/pulls/183/comments")));
  });

  it("checks the head after the liveness lookup and writes nothing when it moved (OBJ-004)", async () => {
    const gh = github();
    const order = [];
    await postRound({ fetch: async (u, i) => { order.push(i?.method ?? "GET"); return gh.fetch(u, i); }, token: "t", appLogin: APP, job: JOB, rounds: 1,
      events: stream([]), livenessStillCurrent: async () => { order.push("check"); return false; } });
    assert.deepEqual(order, ["POST", "GET", "check"]);
  });

  it("counts findings the runner dropped before they became events (OBJ-005)", async () => {
    const gh = github();
    await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, rounds: 1, events: stream([]), engineDropped: 1 });
    const live = gh.calls.filter((c) => c.method === "POST").at(-1);
    assert.match(live.body.body, /0 findings inline, 1 withheld/);
  });

  it("a withheld finding is never reported as no findings (OBJ-005)", async () => {
    assert.equal(roundVerdict({ conclusion: "completed", headSha: HEAD, findings: 0, dropped: 1 }),
      "reviewed `bbbbbbb`, 0 findings inline, 1 withheld (credential-shaped or oversized).");
  });

  it("keys an unplaced finding by its place in the round, so a resume posts the right one (OBJ-006)", async () => {
    const seen = new Map([["unplaced:0", 1]]);
    const journal = { has: (k) => seen.has(k), record: (k, id) => seen.set(k, id) };
    const gh = github({ refuse: new Set(["src/a.js"]) });
    await postRound({ fetch: gh.fetch, token: "t", appLogin: APP, job: JOB, rounds: 1, journal,
      events: stream([finding({ body: "first" }), finding({ path: "src/ok.js" }), finding({ body: "third" })]) });
    const fallbacks = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues/183/comments") && /Not placed inline/.test(c.body.body));
    assert.deepEqual(fallbacks.map((c) => c.body.body.split("\n\n")[1]), ["third"]);
    assert.ok(seen.has("unplaced:2"));
  });

  it("keeps one liveness line per engine when asked, so one engine never erases another's (OBJ-001)", async () => {
    const codex = { id: 9, user: { login: APP }, body: `${LIVENESS_PREFIX} rounds=1 sha=${HEAD} engine=codex -->\nx` };
    const gh = github({ comments: [codex] });
    await upsertLiveness({ fetch: gh.fetch, token: "t", appLogin: APP, repository: JOB.repository, prNumber: 183, body: "y", engine: "opencode" });
    assert.deepEqual(gh.calls.filter((c) => c.method !== "GET").map((c) => c.method), ["POST"]);
    const again = github({ comments: [codex] });
    await upsertLiveness({ fetch: again.fetch, token: "t", appLogin: APP, repository: JOB.repository, prNumber: 183, body: "y", engine: "codex" });
    assert.deepEqual(again.calls.filter((c) => c.method !== "GET").map((c) => c.method), ["PATCH"]);
  });

  it("upserts only a liveness comment this App wrote", async () => {
    const mine = { id: 7, user: { login: APP }, body: `${LIVENESS_PREFIX} rounds=1 -->` };
    const lanes = { id: 5, user: { login: "github-actions[bot]" }, body: `${LIVENESS_PREFIX} rounds=3 -->` };
    const gh = github({ comments: [lanes, mine] });
    await upsertLiveness({ fetch: gh.fetch, token: "t", appLogin: APP, repository: JOB.repository, prNumber: 183, body: "x" });
    assert.deepEqual(gh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`), [
      "PATCH /repos/prismalens/sreforge/issues/comments/7",
    ]);

    const fresh = github({ comments: [lanes] });
    await upsertLiveness({ fetch: fresh.fetch, token: "t", appLogin: APP, repository: JOB.repository, prNumber: 183, body: "x" });
    assert.deepEqual(fresh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`), [
      "POST /repos/prismalens/sreforge/issues/183/comments",
    ]);
  });

  it("says a failed round left no review on the head", () => {
    assert.match(roundVerdict({ conclusion: "failed", headSha: HEAD, findings: 0, failureClass: "api-error" }), /ended failed \(api-error\); this head has no machine review on record/);
    assert.equal(roundVerdict({ conclusion: "completed", headSha: HEAD, findings: 0 }), "reviewed `bbbbbbb`, no findings.");
    assert.ok(livenessBody({ rounds: 0, headSha: null, engine: "opencode", model: null, verdict: "v" }).startsWith(`${LIVENESS_PREFIX} rounds=0 engine=opencode -->`));
    assert.equal(looksLikeSecret("sk-ant-" + "x".repeat(30)), true);
  });
});
