import { describe, expect, it } from "vitest";

import type { FleetRepoRow } from "@/api/types";
import { malformedConfigs, quietRepos, repoParams, summariseRepos } from "./repos";

function repo(overrides: Partial<FleetRepoRow> & { repository: string }): FleetRepoRow {
  return { rounds: 0, denials: 0, last_round: null, last_recorded_at: null, ...overrides };
}

describe("the repos list", () => {
  const rows = [
    repo({
      repository: "o/one",
      rounds: 2,
      denials: 1,
      last_round: {
        session_id: "r2",
        recorded_at: "2026-08-30T01:00:00.000Z",
        round_type: "verify",
        verdict_kind: null,
      },
      last_recorded_at: "2026-08-30T01:00:00.000Z",
    }),
    repo({ repository: "o/quiet", last_recorded_at: "2026-07-15T00:00:00.000Z" }),
  ];

  it("takes the last round per repository and decodes its state", () => {
    const [one] = summariseRepos(rows);
    expect(one.rounds).toBe(2);
    expect(one.lastRound?.session_id).toBe("r2");
    expect(one.lastState).toBe("unknown");
    expect(one.denials).toBe(1);
  });

  it("keeps a repository that has posted but not in this window", () => {
    const summarised = summariseRepos(rows);
    const quiet = summarised.find((r) => r.repository === "o/quiet");
    expect(quiet).toBeDefined();
    expect(quiet?.rounds).toBe(0);
    expect(quiet?.lastRound).toBeNull();
    expect(quiet?.lastState).toBeNull();
  });
});

describe("malformedConfigs", () => {
  it("names a repository whose most recently seen layer failed to parse, by its layer title", () => {
    expect(malformedConfigs([{ repository: "o/broken", layer: "repo_config" }])).toEqual([
      { repository: "o/broken", layer: "Repo config" },
    ]);
  });

  it("says nothing when the fleet route reports no malformed layer", () => {
    expect(malformedConfigs([])).toEqual([]);
  });
});

describe("quietRepos", () => {
  it("names a windowed-quiet repository's true last round from the fleet row", () => {
    const rows = [repo({ repository: "o/quiet", last_recorded_at: "2026-07-15T00:00:00.000Z" })];
    expect(quietRepos(rows)).toEqual([
      { repository: "o/quiet", lastRoundAt: "2026-07-15T00:00:00.000Z" },
    ]);
  });

  it("leaves out a repository that posted in the window", () => {
    const rows = [
      repo({ repository: "o/one", rounds: 1, last_recorded_at: "2026-08-30T01:00:00.000Z" }),
    ];
    expect(quietRepos(rows)).toEqual([]);
  });
});

describe("repoParams", () => {
  it("splits owner/name on the first slash", () => {
    expect(repoParams("prismalens/gh-workflows")).toEqual({
      owner: "prismalens",
      repo: "gh-workflows",
    });
  });

  // A bearer-authenticated ingest accepts any non-empty repository string, so a
  // name with no slash (or an empty owner/repo either side of it) can reach here.
  // Before this fix, indexOf's -1 made owner = "ab" and repo = "abc" for "abc",
  // a wrong link that looked like a normal one.
  it("returns null for a name with no slash", () => {
    expect(repoParams("abc")).toBeNull();
  });

  it("returns null for a name with an empty owner or repo segment", () => {
    expect(repoParams("/abc")).toBeNull();
    expect(repoParams("abc/")).toBeNull();
  });
});
