import { describe, expect, it } from "vitest";

import type { RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import { summariseRepos } from "./repos";

const BASE = makeRounds({ count: 1 })[0];

function round(overrides: Partial<RoundRow>): RoundRow {
  return { ...BASE, ...overrides };
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
