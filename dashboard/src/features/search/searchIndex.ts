import type { FindingRow, RoundRow } from "@/api/types";
import { FILTER_KEYS } from "@/features/filters/grammar";
import { shortSha } from "@/lib/format";

export type ResultKind = "repository" | "pull request" | "finding" | "round" | "filter" | "page";

export type ResultTarget =
  | { to: "/repos/$owner/$repo"; params: { owner: string; repo: string } }
  | { to: "/prs/$owner/$repo/$number"; params: { owner: string; repo: string; number: string } }
  | { to: "/rounds/$sessionId"; params: { sessionId: string } }
  | { to: "/findings"; search: Record<string, string> }
  | { to: "/" | "/inbox" | "/fleet" | "/repos" | "/rounds" | "/prs" };

export interface SearchResult {
  id: string;
  kind: ResultKind;
  title: string;
  detail: string;
  target: ResultTarget;
  score: number;
}

const PAGES: { title: string; to: "/" | "/inbox" | "/fleet" | "/repos" | "/rounds" | "/prs"; keywords: string }[] = [
  { title: "Home", to: "/", keywords: "home today status" },
  { title: "Inbox", to: "/inbox", keywords: "inbox pull requests attention" },
  { title: "Fleet", to: "/fleet", keywords: "fleet charts overview cost tokens" },
  { title: "Repos", to: "/repos", keywords: "repositories repos" },
  { title: "Rounds", to: "/rounds", keywords: "rounds runs sessions" },
  { title: "Pull requests", to: "/prs", keywords: "pull requests prs" },
];

function split(repository: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = repository.split("/");
  return { owner, repo };
}

/** Every word must appear; a match at a word start scores higher. */
function score(haystack: string, words: string[]): number {
  const h = haystack.toLowerCase();
  let total = 0;
  for (const w of words) {
    const i = h.indexOf(w);
    if (i < 0) return 0;
    total += i === 0 || /[\s/#:._-]/.test(h[i - 1] ?? "") ? 3 : 1;
  }
  return total;
}

export interface SearchSources {
  rounds: RoundRow[];
  findings: FindingRow[];
  repositories: string[];
}

/**
 * The palette's matcher (#209). Exact forms jump first: `owner/repo#12`, `#12`,
 * a sha prefix, a session id. Everything else is word matching over names,
 * titles and paths already loaded for other pages; nothing here fetches.
 */
export function searchAll(query: string, src: SearchSources, limitPerKind = 5): SearchResult[] {
  const q = query.trim();
  if (!q) {
    return PAGES.map((p, i) => ({ id: `page:${p.to}`, kind: "page", title: p.title, detail: "go to", target: { to: p.to }, score: 10 - i }));
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out: SearchResult[] = [];

  const prs = new Map<string, RoundRow>();
  for (const r of src.rounds) {
    if (r.pr_number === null) continue;
    const key = `${r.repository}#${r.pr_number}`;
    const prev = prs.get(key);
    if (!prev || r.recorded_at > prev.recorded_at) prs.set(key, r);
  }

  const exactPr = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(q);
  const bareNumber = /^#?(\d+)$/.exec(q);
  const sha = /^[0-9a-f]{7,40}$/i.test(q) ? q.toLowerCase() : null;

  for (const repository of src.repositories) {
    const s = score(repository, words);
    if (s) out.push({ id: `repo:${repository}`, kind: "repository", title: repository, detail: "repository", target: { to: "/repos/$owner/$repo", params: split(repository) }, score: s + 2 });
  }

  for (const [key, r] of prs) {
    const hay = `${key} ${r.pr_title ?? ""} ${r.pr_author ?? ""}`;
    let s = score(hay, words);
    if (exactPr && key.toLowerCase() === `${exactPr[1]}#${exactPr[2]}`.toLowerCase()) s = 100;
    if (bareNumber && String(r.pr_number) === bareNumber[1]) s = Math.max(s, 50);
    if (!s) continue;
    out.push({
      id: `pr:${key}`,
      kind: "pull request",
      title: `${r.repository.split("/")[1]}#${r.pr_number}${r.pr_title ? ` ${r.pr_title}` : ""}`,
      detail: [r.repository, r.pr_author, r.pr_state].filter(Boolean).join(" · "),
      target: { to: "/prs/$owner/$repo/$number", params: { ...split(r.repository), number: String(r.pr_number) } },
      score: s,
    });
  }

  for (const f of src.findings) {
    const loc = `${f.path ?? ""}${f.original_line !== null ? `:${f.original_line}` : ""}`;
    const s = score(`${loc} ${f.repository}#${f.pr_number}`, words);
    if (!s) continue;
    out.push({
      id: `finding:${f.thread_node_id}`,
      kind: "finding",
      title: loc || "(no path)",
      detail: `${f.repository.split("/")[1]}#${f.pr_number}`,
      target: { to: "/findings", search: { repository: f.repository, pr: String(f.pr_number), sel: f.thread_node_id } },
      score: s,
    });
  }

  for (const r of src.rounds) {
    let s = 0;
    if (sha && (r.head_sha ?? "").toLowerCase().startsWith(sha)) s = 60;
    if (r.session_id.toLowerCase().startsWith(q.toLowerCase()) && q.length >= 6) s = 80;
    if (!s) continue;
    out.push({
      id: `round:${r.session_id}`,
      kind: "round",
      title: `${r.round_type ?? "round"} at ${shortSha(r.head_sha)}`,
      detail: `${r.repository}${r.pr_number !== null ? `#${r.pr_number}` : ""} · ${r.recorded_at.slice(0, 16).replace("T", " ")}`,
      target: { to: "/rounds/$sessionId", params: { sessionId: r.session_id } },
      score: s,
    });
  }

  const token = /^(\w+):(\S+)$/.exec(q);
  if (token && (FILTER_KEYS as readonly string[]).includes(token[1]!.toLowerCase())) {
    const key = token[1]!.toLowerCase();
    const param = key === "repo" ? "repository" : key === "state" ? "pr_state" : key;
    out.push({ id: `filter:${q}`, kind: "filter", title: q, detail: "filter Findings", target: { to: "/findings", search: { [param]: token[2]! } }, score: 90 });
  }

  for (const p of PAGES) {
    const s = score(`${p.title} ${p.keywords}`, words);
    if (s) out.push({ id: `page:${p.to}`, kind: "page", title: p.title, detail: "go to", target: { to: p.to }, score: s });
  }

  const byKind = new Map<ResultKind, SearchResult[]>();
  for (const r of out.sort((a, b) => b.score - a.score)) {
    const list = byKind.get(r.kind) ?? [];
    if (list.length < limitPerKind) list.push(r);
    byKind.set(r.kind, list);
  }
  return [...byKind.values()].flat().sort((a, b) => b.score - a.score);
}
