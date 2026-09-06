import { describe, expect, it } from "vitest";

import type { RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import { malformedConfigs, quietRepos, summariseRepos } from "./repos";

const BASE = makeRounds({ count: 1 })[0];

function round(overrides: Partial<RoundRow>): RoundRow {
  return { ...BASE, ...overrides };
}

function configResolution(outcome: string): string {
  return JSON.stringify({
    layers: {
      repo_config: { outcome, unconsumed: [] },
      org_defaults: { outcome: "absent", unconsumed: [] },
      workflow_inputs: { outcome: "ok", unconsumed: [] },
    },
  });
}

describe("the repos list", () => {
  const rows = [
    round({ session_id: "r1", repository: "o/one", recorded_at: "2026-08-29T01:00:00.000Z", round_type: "full", permission_denials: 1 }),
    round({ session_id: "r2", repository: "o/one", recorded_at: "2026-08-30T01:00:00.000Z", round_type: "verify", permission_denials: 0 }),
  ];

  it("takes the last round per repository and decodes its state", () => {
    const [one] = summariseRepos(rows, ["o/one"]);
    expect(one.rounds).toBe(2);
    expect(one.lastRound?.session_id).toBe("r2");
    expect(one.lastState).toBe("unknown");
    expect(one.denials).toBe(1);
  });

  it("keeps a repository that has posted but not in this window", () => {
    const summarised = summariseRepos(rows, ["o/one", "o/quiet"]);
    const quiet = summarised.find((repo) => repo.repository === "o/quiet");
    expect(quiet).toBeDefined();
    expect(quiet?.rounds).toBe(0);
    expect(quiet?.lastRound).toBeNull();
    expect(quiet?.lastState).toBeNull();
  });
});

describe("malformedConfigs", () => {
  it("names a repository whose most recently seen layer failed to parse", () => {
    const blobRows = [
      round({
        session_id: "b1",
        repository: "o/broken",
        recorded_at: "2026-08-30T01:00:00.000Z",
        config_resolution: configResolution("unparseable"),
      }),
    ];
    const watch = malformedConfigs(blobRows);
    expect(watch).toEqual([{ repository: "o/broken", layer: "Repo config" }]);
  });

  it("says nothing about a repository whose layers all parsed", () => {
    const blobRows = [
      round({
        session_id: "b2",
        repository: "o/fine",
        recorded_at: "2026-08-30T01:00:00.000Z",
        config_resolution: configResolution("ok"),
      }),
    ];
    expect(malformedConfigs(blobRows)).toEqual([]);
  });
});

describe("quietRepos", () => {
  it("names a windowed-quiet repository's true last round from the unwindowed rows", () => {
    const windowedRepos = summariseRepos([], ["o/quiet"]);
    const allTimeRows = [
      round({ session_id: "a1", repository: "o/quiet", recorded_at: "2026-07-01T00:00:00.000Z" }),
      round({ session_id: "a2", repository: "o/quiet", recorded_at: "2026-07-15T00:00:00.000Z" }),
    ];
    expect(quietRepos(windowedRepos, allTimeRows)).toEqual([
      { repository: "o/quiet", lastRoundAt: "2026-07-15T00:00:00.000Z" },
    ]);
  });

  it("leaves out a repository that posted in the window", () => {
    const posted = [round({ session_id: "p1", repository: "o/one" })];
    const windowedRepos = summariseRepos(posted, ["o/one"]);
    expect(quietRepos(windowedRepos, posted)).toEqual([]);
  });
});
