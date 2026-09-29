// The poster (#184): publishes a runner's round on the pull request under the App's login.
// It writes inline review comments, one summary issue comment and its own liveness comment.
// It never calls POST /pulls/:n/reviews, so a runner round can neither approve nor block.

const GITHUB_API = "https://api.github.com";
export const LIVENESS_PREFIX = "<!-- claude-review-liveness";
// GitHub refuses a comment body over 65536 characters.
const MAX_BODY = 65000;

// Credential-shaped tokens, the same families runner/src/acp-map.js drops before posting.
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecret(text) {
  return typeof text === "string" && SECRET_PATTERNS.some((p) => p.test(text));
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "assayer-control-plane",
    "Content-Type": "application/json",
  };
}

export function livenessBody({ rounds, headSha, engine, model, verdict }) {
  const marker = `${LIVENESS_PREFIX} rounds=${rounds}${headSha ? ` sha=${headSha}` : ""} engine=${engine} -->`;
  const ran = model ? `${engine}, ${model}` : engine;
  return `${marker}\n**Assayer review** (${ran}): ${verdict}`;
}

// The round's verdict line, from what it posted and how it finished.
export function roundVerdict({ conclusion, headSha, findings, failureClass }) {
  const short = String(headSha).slice(0, 7);
  if (conclusion === "completed") {
    return findings === 0
      ? `reviewed \`${short}\`, no findings.`
      : `reviewed \`${short}\`, ${findings} finding${findings === 1 ? "" : "s"} inline.`;
  }
  const why = failureClass ? ` (${failureClass})` : "";
  return `the round on \`${short}\` ended ${conclusion ?? "without a conclusion"}${why}; this head has no machine review on record.`;
}

async function call(fetchImpl, token, method, path, body) {
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const err = new Error(`github ${method} ${path.replace(/\/\d+(\/|$)/g, "/:n$1")} ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Upserts only a comment this App wrote, as the lane upserts only github-actions[bot]'s: without
// the author filter anyone could pre-create a marker comment and have it republished.
export async function upsertLiveness({ fetch: fetchImpl, token, appLogin, repository, prNumber, body }) {
  let existing = null;
  for (let page = 1; page <= 10 && existing === null; page++) {
    const rows = await call(fetchImpl, token, "GET", `/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    for (const c of rows) {
      if (c?.user?.login === appLogin && typeof c.body === "string" && c.body.startsWith(LIVENESS_PREFIX)) {
        existing = c.id;
        break;
      }
    }
    if (rows.length < 100) break;
  }
  if (existing !== null) {
    await call(fetchImpl, token, "PATCH", `/repos/${repository}/issues/comments/${existing}`, { body });
  } else {
    await call(fetchImpl, token, "POST", `/repos/${repository}/issues/${prNumber}/comments`, { body });
  }
}

// Posts one finished round. `events` are this attempt's events, oldest first. Returns counts;
// a finding GitHub refuses (a line outside the diff, say) is counted, never fatal.
export async function postRound({ fetch: fetchImpl, token, appLogin, job, events, rounds }) {
  const out = { inline: 0, refused: 0, summary: 0 };
  const findings = events.filter((e) => e.type === "finding");
  for (const f of findings) {
    if (typeof f.body !== "string" || !f.body.trim() || looksLikeSecret(f.body) || f.body.length > MAX_BODY) {
      out.refused += 1;
      continue;
    }
    if (typeof f.path !== "string" || !Number.isInteger(f.line) || f._meta?.path_outside_checkout) {
      out.refused += 1;
      continue;
    }
    const comment = {
      body: f.body,
      commit_id: job.head_sha,
      path: f.path,
      line: f.line,
      side: f.side === "LEFT" ? "LEFT" : "RIGHT",
    };
    const start = f._meta?.start_line;
    if (Number.isInteger(start) && start < f.line) {
      comment.start_line = start;
      comment.start_side = comment.side;
    }
    try {
      await call(fetchImpl, token, "POST", `/repos/${job.repository}/pulls/${job.pr_number}/comments`, comment);
      out.inline += 1;
    } catch (e) {
      if (e.status !== 422) throw e;
      out.refused += 1;
    }
  }

  let summary = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "summary") {
      summary = events[i];
      break;
    }
  }
  if (summary && typeof summary.body === "string" && summary.body.trim() && !looksLikeSecret(summary.body)) {
    await call(fetchImpl, token, "POST", `/repos/${job.repository}/issues/${job.pr_number}/comments`, {
      body: summary.body.slice(0, MAX_BODY),
    });
    out.summary = 1;
  }

  const started = events.find((e) => e.type === "started");
  const finished = events.findLast((e) => e.type === "finished");
  const error = events.findLast((e) => e.type === "error");
  const verdict = roundVerdict({
    conclusion: finished?.conclusion,
    headSha: job.head_sha,
    findings: out.inline,
    failureClass: error?.failure_class,
  });
  await upsertLiveness({
    fetch: fetchImpl,
    token,
    appLogin,
    repository: job.repository,
    prNumber: job.pr_number,
    body: livenessBody({
      rounds,
      headSha: job.head_sha,
      engine: job.engine,
      model: started?._meta?.served_model ?? started?.model ?? job.model,
      verdict,
    }),
  });
  return out;
}

export async function revokeToken(fetchImpl, token) {
  try {
    await fetchImpl(`${GITHUB_API}/installation/token`, { method: "DELETE", headers: headers(token) });
  } catch {
    // The token lapses at GitHub's one-hour expiry either way.
  }
}
