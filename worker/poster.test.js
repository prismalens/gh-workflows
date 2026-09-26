import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LIVENESS_PREFIX, livenessBody, looksLikeSecret, postRound, roundVerdict, upsertLiveness } from "./poster.js";

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
    assert.deepEqual(r, { inline: 2, refused: 0, summary: 1 });
    const writes = gh.calls.filter((c) => c.method !== "GET");
    assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), [
      "POST /repos/prismalens/sreforge/pulls/183/comments",
      "POST /repos/prismalens/sreforge/pulls/183/comments",
      "POST /repos/prismalens/sreforge/issues/183/comments",
      "POST /repos/prismalens/sreforge/issues/183/comments",
    ]);
    assert.deepEqual(writes[0].body, { body: envelope, commit_id: HEAD, path: "src/a.js", line: 12, side: "RIGHT" });
    assert.equal(writes[1].body.start_line, 18);
    assert.ok(writes[3].body.body.startsWith(`${LIVENESS_PREFIX} rounds=1 sha=${HEAD} engine=opencode -->`));
    assert.match(writes[3].body.body, /opencode\/muse-2\): reviewed `bbbbbbb`, 2 findings inline\./);
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
    assert.deepEqual(r, { inline: 1, refused: 4, summary: 1 });
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
