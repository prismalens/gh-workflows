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
  /** Lane events skipped as an unchanged patch, and rounds on an unmerged base PR (#179). */
  restacks: FleetRepoRow["restacks"];
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
    restacks: row.restacks,
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

/**
 * `owner/name` split into the params of /repos/$owner/$repo. Null for a name
 * that does not split into a non-empty owner and repo: a bearer-authenticated
 * ingest accepts any non-empty `repository` string, so this can reach here.
 */
export function repoParams(repository: string): { owner: string; repo: string } | null {
  const slash = repository.indexOf("/");
  if (slash <= 0 || slash === repository.length - 1) return null;
  return { owner: repository.slice(0, slash), repo: repository.slice(slash + 1) };
}

/** Worst first. A repository is healthy only when its last round reviewed code, with no denials. */
export const REPO_HEALTH = ["malformed-config", "not-reviewed", "denials", "quiet", "healthy"] as const;
export type RepoHealth = (typeof REPO_HEALTH)[number];

export const REPO_HEALTH_LABEL: Record<RepoHealth, string> = {
  "malformed-config": "config does not parse",
  "not-reviewed": "last round did not review",
  denials: "permission denials",
  quiet: "quiet in the window",
  healthy: "healthy",
};

export function repoHealth(repo: RepoSummary, malformed: ReadonlySet<string>): RepoHealth {
  if (malformed.has(repo.repository)) return "malformed-config";
  if (repo.rounds === 0) return "quiet";
  if (repo.lastState !== "reviewed") return "not-reviewed";
  if (repo.denials > 0) return "denials";
  return "healthy";
}

export interface OwnerGroup {
  owner: string;
  worst: RepoHealth;
  /** Worst first, then by name. */
  repos: { repo: RepoSummary; health: RepoHealth }[];
}

/** Repos grouped by owner, the group with the worst repository first (#185). */
export function groupByOwner(repos: RepoSummary[], malformed: ReadonlySet<string>): OwnerGroup[] {
  const rank = (h: RepoHealth) => REPO_HEALTH.indexOf(h);
  const groups = new Map<string, OwnerGroup["repos"]>();
  for (const repo of repos) {
    const owner = repo.repository.includes("/") ? repo.repository.split("/")[0] : repo.repository;
    const list = groups.get(owner) ?? [];
    list.push({ repo, health: repoHealth(repo, malformed) });
    groups.set(owner, list);
  }
  return [...groups.entries()]
    .map(([owner, list]) => {
      list.sort((a, b) => rank(a.health) - rank(b.health) || a.repo.repository.localeCompare(b.repo.repository));
      return { owner, worst: list[0].health, repos: list };
    })
    .sort((a, b) => rank(a.worst) - rank(b.worst) || a.owner.localeCompare(b.owner));
}
