import type { RoundRow } from "@/api/types";
// Reuses the failures page's own parse-outcome derivation (#141), so the two
// pages can never disagree about what counts as malformed.
import { summariseConfigs } from "@/features/failures/failures";
import { decodeVerdict, type VerdictState } from "@/honesty/verdict";

export interface RepoSummary {
  repository: string;
  /** Rounds this repository recorded inside the selected window. */
  rounds: number;
  /** Its most recent round in the window, or null when it posted none. */
  lastRound: RoundRow | null;
  /** The two-state decoding of that last round. Null when there is no round. */
  lastState: VerdictState | null;
  denials: number;
}

/**
 * Every repository that has ever posted, whether or not it posted inside the
 * window. A repository with nothing in range stays on the list saying so:
 * dropping it would make a quiet repository and a repository that never existed
 * look the same, which is the confusion this page is for.
 *
 * `everPosted` comes from GET /api/summary, which reads the whole table, so it is
 * the one denominator here that is not window-limited.
 */
export function summariseRepos(rows: RoundRow[], everPosted: string[]): RepoSummary[] {
  const byRepo = new Map<string, RoundRow[]>();
  for (const row of rows) {
    const bucket = byRepo.get(row.repository) ?? [];
    bucket.push(row);
    byRepo.set(row.repository, bucket);
  }

  const names = [...new Set([...everPosted, ...byRepo.keys()])].sort();

  return names.map((repository) => {
    const owned = byRepo.get(repository) ?? [];
    const lastRound = owned.reduce<RoundRow | null>(
      (latest, row) =>
        latest === null || row.recorded_at > latest.recorded_at ? row : latest,
      null,
    );
    return {
      repository,
      rounds: owned.length,
      lastRound,
      lastState: lastRound ? decodeVerdict(lastRound) : null,
      denials: owned.reduce((sum, row) => sum + (row.permission_denials ?? 0), 0),
    };
  });
}

export interface MalformedConfigWatch {
  repository: string;
  /** The human layer name, e.g. "Repo config", not the raw layer key. */
  layer: string;
}

/**
 * A repository whose most recently seen config layer failed to parse, straight
 * from `summariseConfigs`'s own newest-first scan over `blobRows`.
 */
export function malformedConfigs(blobRows: RoundRow[]): MalformedConfigWatch[] {
  const { items } = summariseConfigs(blobRows);
  return items
    .filter((item) => item.outcome === "unparseable" || item.outcome === "schema-rejected")
    .map((item) => ({ repository: item.repository, layer: item.layerTitle }));
}

export interface QuietRepoWatch {
  repository: string;
  /** The most recent round this repository ever posted, or null if none was found. */
  lastRoundAt: string | null;
}

/**
 * Repositories with nothing in the window (`rounds === 0` from `summariseRepos`),
 * paired with their true last round from an unwindowed fetch, so "quiet" can name
 * when it last spoke rather than just that it is silent now.
 */
export function quietRepos(repos: RepoSummary[], allTimeRows: RoundRow[]): QuietRepoWatch[] {
  const lastByRepo = new Map<string, string>();
  for (const row of allTimeRows) {
    const prev = lastByRepo.get(row.repository);
    if (prev === undefined || row.recorded_at > prev) {
      lastByRepo.set(row.repository, row.recorded_at);
    }
  }

  return repos
    .filter((repo) => repo.rounds === 0)
    .map((repo) => ({
      repository: repo.repository,
      lastRoundAt: lastByRepo.get(repo.repository) ?? null,
    }));
}
