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

// The sweep knows a runner's finding by this marker, since the App's login differs per install
// (review-findings-sweep.yml, #184).
export function findingMarker(engine) {
  return typeof engine === "string" && /^[a-z0-9-]{1,32}$/.test(engine) ? `<!-- assayer-finding engine=${engine} -->` : "";
}

// A posted body never @-mentions: a finding that quotes `@claude review` would otherwise summon
// a lane from the operator's own login (OBJ-023). A zero-width joiner keeps the text readable.
export function quiet(text) {
  return typeof text === "string" ? text.replace(/@(?=[A-Za-z0-9])/g, "@\u200d") : text;
}

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
export function roundVerdict({ conclusion, headSha, findings, failureClass, unplaced = 0, dropped = 0 }) {
  const short = String(headSha).slice(0, 7);
  if (conclusion === "completed") {
    // A finding GitHub would not anchor is still a finding: "no findings" would be false (OBJ-005).
    const missed = unplaced > 0 ? `, ${unplaced} not placed inline (posted as comments)` : "";
    const lost = dropped > 0 ? `, ${dropped} withheld (credential-shaped or oversized)` : "";
    if (findings === 0 && unplaced === 0 && dropped === 0) return `reviewed \`${short}\`, no findings.`;
    return `reviewed \`${short}\`, ${findings} finding${findings === 1 ? "" : "s"} inline${missed}${lost}.`;
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
// the author filter anyone could pre-create a marker comment and have it republished. With
// `engine`, each engine keeps its own line, so one engine's round never erases another's record.
export async function upsertLiveness({ fetch: fetchImpl, token, appLogin, repository, prNumber, body, engine = null }) {
  let existing = null;
  for (let page = 1; page <= 10 && existing === null; page++) {
    const rows = await call(fetchImpl, token, "GET", `/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    for (const c of rows) {
      const head = typeof c?.body === "string" ? c.body.split("\n")[0] : "";
      if (c?.user?.login === appLogin && head.startsWith(LIVENESS_PREFIX) && (engine === null || head.includes(` engine=${engine} `))) {
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
// a finding GitHub refuses (a line outside the diff, say) is counted, never fatal, and posted
// as its own issue comment so the round's text is never lost. A finding with a credential-shaped body
// is dropped outright. `journal` (optional: has(key), record(key, id)) lets a caller resume a
// publish that stopped partway without posting twice (OBJ-006).
export async function postRound({ fetch: fetchImpl, token, appLogin, job, events, rounds, journal = null, skipLiveness = false, livenessStillCurrent = null, engineLiveness = false }) {
  const out = { inline: 0, refused: 0, summary: 0, unplaced: 0 };
  const unplaced = [];
  const findings = events.filter((e) => e.type === "finding");
  const marker = findingMarker(job.engine);
  for (const [i, f] of findings.entries()) {
    const key = `finding:${i}`;
    if (journal?.has(key)) {
      out.inline += 1;
      continue;
    }
    if (typeof f.body !== "string" || !f.body.trim() || looksLikeSecret(f.body) || f.body.length > MAX_BODY) {
      out.refused += 1;
      continue;
    }
    if (typeof f.path !== "string" || !Number.isInteger(f.line) || f._meta?.path_outside_checkout) {
      out.refused += 1;
      unplaced.push({ f, i });
      continue;
    }
    const comment = {
      body: marker ? `${quiet(f.body)}\n\n${marker}` : quiet(f.body),
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
      const posted = await call(fetchImpl, token, "POST", `/repos/${job.repository}/pulls/${job.pr_number}/comments`, comment);
      journal?.record(key, posted?.id ?? null);
      out.inline += 1;
    } catch (e) {
      if (e.status !== 422) throw e;
      out.refused += 1;
      unplaced.push({ f, i });
    }
  }
  out.unplaced = unplaced.length;

  let summary = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "summary") {
      summary = events[i];
      break;
    }
  }
  const summaryBody = summary && typeof summary.body === "string" && summary.body.trim() && !looksLikeSecret(summary.body) ? summary.body : null;
  if (summaryBody && journal?.has("summary")) {
    out.summary = 1;
  } else if (summaryBody) {
    const posted = await call(fetchImpl, token, "POST", `/repos/${job.repository}/issues/${job.pr_number}/comments`, {
      body: quiet(summaryBody).slice(0, MAX_BODY),
    });
    journal?.record("summary", posted?.id ?? null);
    out.summary = 1;
  }
  // Each finding GitHub would not anchor gets its own issue comment: one combined body could
  // pass 65,000 characters and lose some silently. The location is engine text too, so the
  // whole comment is screened, not just the finding's body.
  for (const { f, i } of unplaced) {
    const key = `unplaced:${i}`;
    const where = typeof f.path === "string" ? `\`${f.path}${Number.isInteger(f.line) ? `:${f.line}` : ""}\`` : "no location";
    const body = quiet(`**Not placed inline** (${where}): GitHub would not anchor this finding on the diff.\n\n${f.body}`);
    if (journal?.has(key)) continue;
    if (looksLikeSecret(body) || body.length > MAX_BODY) {
      out.unplaced -= 1;
      continue;
    }
    const posted = await call(fetchImpl, token, "POST", `/repos/${job.repository}/issues/${job.pr_number}/comments`, { body });
    journal?.record(key, posted?.id ?? null);
  }

  const started = events.find((e) => e.type === "started");
  const finished = events.findLast((e) => e.type === "finished");
  const error = events.findLast((e) => e.type === "error");
  const verdict = roundVerdict({
    conclusion: finished?.conclusion,
    headSha: job.head_sha,
    findings: out.inline,
    unplaced: out.unplaced,
    dropped: out.refused - out.unplaced,
    failureClass: error?.failure_class,
  });
  // A replayed publish, or one for a head the PR has moved past, must not rewrite the
  // standing verdict (principle 14).
  if (journal?.has("liveness") || skipLiveness) return out;
  if (livenessStillCurrent && !(await livenessStillCurrent())) return out;
  await upsertLiveness({
    fetch: fetchImpl,
    token,
    appLogin,
    repository: job.repository,
    prNumber: job.pr_number,
    engine: engineLiveness ? job.engine : null,
    body: livenessBody({
      rounds,
      headSha: job.head_sha,
      engine: job.engine,
      model: started?._meta?.served_model ?? started?.model ?? job.model,
      verdict,
    }),
  });
  journal?.record("liveness", null);
  return out;
}

export async function revokeToken(fetchImpl, token) {
  try {
    await fetchImpl(`${GITHUB_API}/installation/token`, { method: "DELETE", headers: headers(token) });
  } catch {
    // The token lapses at GitHub's one-hour expiry either way.
  }
}
