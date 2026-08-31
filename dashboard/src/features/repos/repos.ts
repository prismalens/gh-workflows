import type { RoundRow } from "@/api/types";
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
