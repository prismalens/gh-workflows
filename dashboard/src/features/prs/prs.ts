import type { PrRow, RoundRow } from "@/api/types";
import { formatCompactRounds } from "@/lib/format";
import {
  ATTENTION_RANKS,
  decodeHeadStatus,
  type HeadStatus,
} from "./headStatus";

export interface PRSummary {
  id: string;
  repository: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: string;
  /** True until a prs row enriches this PR; the state shown is then the round's guess (#141). */
  stateIsFallback: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  prsUpdatedAt: string | null;
  url: string | null;
  rounds: RoundRow[];
  latestRound: RoundRow;
  headSha: string | null;
  headStatus: HeadStatus;
  roundsCountByType: { full: number; incremental: number; verify: number };
  compactRounds: string;
  lastRoundAt: string;
  lastModel: string | null;
}

/**
 * Derives PR summaries from raw round telemetry rows (#75).
 * A PR is identified by repository and pr_number; titles and metadata are taken
 * from the most recently recorded round (#72).
 */
export function groupRoundsByPR(rows: RoundRow[]): PRSummary[] {
  const groups = new Map<string, RoundRow[]>();
  for (const row of rows) {
    if (row.pr_number === null) continue;
    const key = `${row.repository}#${row.pr_number}`;
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const result: PRSummary[] = [];
  for (const [key, prRounds] of groups.entries()) {
    prRounds.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
    const latestRound = prRounds[0];
    const slash = latestRound.repository.indexOf("/");
    const owner = slash !== -1 ? latestRound.repository.slice(0, slash) : "";
    const repo = slash !== -1 ? latestRound.repository.slice(slash + 1) : latestRound.repository;
    const headStatus = decodeHeadStatus(latestRound);
    const compactRounds = formatCompactRounds(prRounds);

    let full = 0;
    let incremental = 0;
    let verify = 0;
    for (const r of prRounds) {
      if (r.round_type === "incremental") {
        incremental++;
      } else if (r.round_type === "verify") {
        verify++;
      } else if (r.round_type === "full" || r.round_type === "review") {
        full++;
      }
    }

    result.push({
      id: key,
      repository: latestRound.repository,
      owner,
      repo,
      number: latestRound.pr_number!,
      title: latestRound.pr_title || `PR #${latestRound.pr_number}`,
      author: latestRound.pr_author || "—",
      state: latestRound.pr_state || "open",
      stateIsFallback: true,
      mergedAt: null,
      closedAt: null,
      prsUpdatedAt: null,
      url:
        latestRound.pr_url ||
        `https://github.com/${latestRound.repository}/pull/${latestRound.pr_number}`,
      rounds: prRounds,
      latestRound,
      headSha: latestRound.head_sha,
      headStatus,
      roundsCountByType: { full, incremental, verify },
      compactRounds,
      lastRoundAt: latestRound.recorded_at,
      lastModel: latestRound.model,
    });
  }

  return result;
}

/** Attention sort: failed > did-not-run > threads-only > reviewed, newest first (#75). */
export function comparePRsByAttention(a: PRSummary, b: PRSummary): number {
  const rankA = ATTENTION_RANKS[a.headStatus.state];
  const rankB = ATTENTION_RANKS[b.headStatus.state];
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return b.lastRoundAt.localeCompare(a.lastRoundAt);
}

export function filterPRsByState(prs: PRSummary[], state?: string): PRSummary[] {
  if (!state || state === "all") return prs;
  return prs.filter((p) => p.state.toLowerCase() === state.toLowerCase());
}

/**
 * Enriches PR summaries with the prs table's current state, title and author
 * (#136, #141): a matching prs row replaces the round-derived guess outright.
 * A prs row with no PR in the base set is dropped; the base set's window
 * (repository/range already applied by the caller) is the frame of this page.
 */
export function enrichPRs(prs: PRSummary[], prsRows: PrRow[]): PRSummary[] {
  const byKey = new Map(prsRows.map((row) => [`${row.repository}#${row.pr_number}`, row]));
  return prs.map((pr) => {
    const row = byKey.get(pr.id);
    if (!row) return pr;
    return {
      ...pr,
      state: row.state || pr.state,
      title: row.title || pr.title,
      author: row.author || pr.author,
      stateIsFallback: false,
      mergedAt: row.merged_at,
      closedAt: row.closed_at,
      prsUpdatedAt: row.updated_at,
    };
  });
}
