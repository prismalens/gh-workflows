import type { FleetLastRound, FleetRepoRow } from "@/api/types";
// The failures page's own layer names (#141), so the two pages title a layer alike.
import { CONFIG_LAYERS } from "@/features/failures/failures";
import { decodeVerdict, type VerdictState } from "@/honesty/verdict";

export interface RepoSummary {
  repository: string;
  /** Rounds this repository recorded inside the selected window. */
  rounds: number;
  /** Its most recent round in the window, or null when it posted none. */
  lastRound: FleetLastRound | null;
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
 * GET /api/fleet/repos already returns that all-time list with the window's
 * counts on each row (#185), so this only decodes the last round's state.
 */
export function summariseRepos(rows: FleetRepoRow[]): RepoSummary[] {
  return rows.map((row) => ({
    repository: row.repository,
    rounds: row.rounds,
    lastRound: row.last_round,
    lastState: row.last_round ? decodeVerdict(row.last_round) : null,
    denials: row.denials,
  }));
}

export interface MalformedConfigWatch {
  repository: string;
  /** The human layer name, e.g. "Repo config", not the raw layer key. */
  layer: string;
}

/**
 * A repository whose most recently seen config layer failed to parse, as the
 * Worker decided it in SQL over every round in the window (#185).
 */
export function malformedConfigs(
  items: { repository: string; layer: string }[],
): MalformedConfigWatch[] {
  const titles = new Map<string, string>(CONFIG_LAYERS.map((l) => [l.layer, l.layerTitle]));
  return items.map((item) => ({
    repository: item.repository,
    layer: titles.get(item.layer) ?? item.layer,
  }));
}

export interface QuietRepoWatch {
  repository: string;
  /** The most recent round this repository ever posted, or null if none was found. */
  lastRoundAt: string | null;
}

/**
 * Repositories with nothing in the window, paired with their true last round
 * (`last_recorded_at` is all-time on the fleet route), so "quiet" can name when
 * it last spoke rather than just that it is silent now.
 */
export function quietRepos(rows: FleetRepoRow[]): QuietRepoWatch[] {
  return rows
    .filter((row) => row.rounds === 0)
    .map((row) => ({ repository: row.repository, lastRoundAt: row.last_recorded_at }));
}
