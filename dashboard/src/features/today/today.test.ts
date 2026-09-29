import { describe, expect, it } from "vitest";

import type { FindingRow, FleetReposResponse, PrRow, RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import { buildToday } from "./today";

const now = new Date("2026-09-24T12:00:00.000Z");
const DAY_MS = 86_400_000;
const baseRound = makeRounds({ count: 1, now })[0]!;

function makeRound(overrides: Partial<RoundRow> = {}): RoundRow {
  return {
    ...baseRound,
    session_id: `s-${Math.random().toString(36).slice(2)}`,
    repository: "acme/web",
    pr_number: 1,
    pr_title: "Test PR",
    pr_author: "alice",
    pr_state: "open",
    head_sha: "abc1234",
    round_type: "review",
    verdict_kind: "reviewed",
    job_conclusion: "success",
    recorded_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
    permission_denials: 0,
    duration_ms: 60_000,
    input_tokens: 1000,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 500,
    total_cost_usd: 0.05,
    round_ordinal: 1,
    run_id: 100,
    run_attempt: 1,
    ...overrides,
  };
}

function makePr(overrides: Partial<PrRow> = {}): PrRow {
  return {
    repository: "acme/web",
    pr_number: 1,
    state: "open",
    title: "Test PR",
    author: "alice",
    base_ref: "main",
    head_ref: "feat",
    head_sha: "abc1234",
    merged_at: null,
    closed_at: null,
    updated_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
    source: "hook",
    total_findings: 0,
    open_findings: 0,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    thread_node_id: `PRRT_${Math.random().toString(36).slice(2)}`,
    repository: "acme/web",
    pr_number: 1,
    path: "src/main.ts",
    original_line: 10,
    line: 10,
    is_resolved: 0,
    is_outdated: 0,
    resolved_by_login: null,
    thread_created_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
    header_raw: "Finding header",
    body_excerpt: "Finding body",
    diff_hunk: "@@ -1,1 +1,1 @@",
    human_reply_count: 0,
    human_reply_sha: null,
    fix_sha: null,
    fix_sha_source: null,
    verify_verdict: null,
    head_sha_reviewed: "abc1234",
    last_swept_at: now.toISOString(),
    row_set_incomplete: 0,
    ...overrides,
  };
}

const emptyFleet: FleetReposResponse = {
  window: { range: "7d", since: null, label: "the last 7 days" },
  rounds: 0,
  repositories: [],
  malformed_configs: [],
};

describe("buildToday", () => {
  it("never-answered findings on an OPEN PR produce one grouped need with the oldest age", () => {
    const rounds = [makeRound({ repository: "acme/web", pr_number: 10 })];
    const prs = [makePr({ repository: "acme/web", pr_number: 10, state: "open" })];
    const f1 = makeFinding({
      repository: "acme/web",
      pr_number: 10,
      thread_created_at: new Date(now.getTime() - 2 * DAY_MS).toISOString(),
    });
    const f2 = makeFinding({
      repository: "acme/web",
      pr_number: 10,
      thread_created_at: new Date(now.getTime() - 5 * DAY_MS).toISOString(),
    });

    const model = buildToday({
      rounds,
      prs,
      findings: [f1, f2],
      fleet: emptyFleet,
      now,
    });

    const need = model.needs.find(
      (n) => n.repository === "acme/web" && n.prNumber === 10 && n.kind === "never-answered",
    );
    expect(need).toBeDefined();
    expect(need!.ageDays).toBe(5);
    expect(need!.since).toBe(f2.thread_created_at);
    expect(need!.what).toBe("2 findings never answered");
  });

  it("findings on a closed PR produce no needs", () => {
    const rounds = [makeRound({ repository: "acme/web", pr_number: 11, pr_state: "closed" })];
    const prs = [makePr({ repository: "acme/web", pr_number: 11, state: "closed" })];
    const f = makeFinding({ repository: "acme/web", pr_number: 11, is_resolved: 0 });

    const model = buildToday({
      rounds,
      prs,
      findings: [f],
      fleet: emptyFleet,
      now,
    });

    const need = model.needs.find((n) => n.prNumber === 11);
    expect(need).toBeUndefined();
  });

  it("a failed head older than 14 days produces no needs", () => {
    const oldRecordedAt = new Date(now.getTime() - 15 * DAY_MS).toISOString();
    const rounds = [
      makeRound({
        repository: "acme/web",
        pr_number: 12,
        job_conclusion: "failure",
        verdict_kind: "silent",
        recorded_at: oldRecordedAt,
      }),
    ];
    const prs = [
      makePr({
        repository: "acme/web",
        pr_number: 12,
        state: "open",
        updated_at: oldRecordedAt,
      }),
    ];

    const model = buildToday({
      rounds,
      prs,
      findings: [],
      fleet: emptyFleet,
      now,
    });

    const need = model.needs.find((n) => n.prNumber === 12);
    expect(need).toBeUndefined();
  });

  it("needs sort failed > never-answered > head-not-read and older first within a kind", () => {
    const rFailedOld = makeRound({
      session_id: "s-fail-old",
      pr_number: 21,
      job_conclusion: "failure",
      verdict_kind: "silent",
      recorded_at: new Date(now.getTime() - 8 * DAY_MS).toISOString(),
    });
    const rFailedRecent = makeRound({
      session_id: "s-fail-recent",
      pr_number: 22,
      job_conclusion: "failure",
      verdict_kind: "silent",
      recorded_at: new Date(now.getTime() - 2 * DAY_MS).toISOString(),
    });
    const rReviewed = makeRound({
      session_id: "s-rev",
      pr_number: 23,
      verdict_kind: "reviewed",
      recorded_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
    });
    const rThreadsOnly = makeRound({
      session_id: "s-threads",
      pr_number: 24,
      round_type: "verify",
      verdict_kind: "verify-rechecked",
      recorded_at: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
    });

    const prs = [
      makePr({ pr_number: 21, state: "open" }),
      makePr({ pr_number: 22, state: "open" }),
      makePr({ pr_number: 23, state: "open" }),
      makePr({ pr_number: 24, state: "open" }),
    ];

    const findingFor23 = makeFinding({
      pr_number: 23,
      thread_created_at: new Date(now.getTime() - 4 * DAY_MS).toISOString(),
    });

    const model = buildToday({
      rounds: [rFailedRecent, rFailedOld, rReviewed, rThreadsOnly],
      prs,
      findings: [findingFor23],
      fleet: emptyFleet,
      now,
    });

    const kinds = model.needs.map((n) => ({ kind: n.kind, pr: n.prNumber, age: n.ageDays }));

    expect(kinds).toEqual([
      { kind: "failed", pr: 21, age: 8 },
      { kind: "failed", pr: 22, age: 2 },
      { kind: "never-answered", pr: 23, age: 4 },
      { kind: "head-not-read", pr: 24, age: 3 },
    ]);
  });

  it("the denial anomaly appears when a repo has >=20 denials and >=2 per round and not otherwise", () => {
    // Repo A: 20 denials across 10 rounds => 2.0 per round, 20 total -> appears
    const repoARounds = Array.from({ length: 10 }, (_, i) =>
      makeRound({
        session_id: `s-a-${i}`,
        repository: "acme/alpha",
        permission_denials: 2,
        recorded_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
      }),
    );

    // Repo B: 19 denials across 5 rounds => 3.8 per round, but 19 total (<20) -> does not appear
    const repoBRounds = Array.from({ length: 5 }, (_, i) =>
      makeRound({
        session_id: `s-b-${i}`,
        repository: "acme/beta",
        permission_denials: i === 0 ? 7 : 3, // sum = 19
        recorded_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
      }),
    );

    // Repo C: 20 denials across 11 rounds => 1.81 per round (<2.0) -> does not appear
    const repoCRounds = Array.from({ length: 11 }, (_, i) =>
      makeRound({
        session_id: `s-c-${i}`,
        repository: "acme/gamma",
        permission_denials: i < 9 ? 2 : 1, // sum = 20
        recorded_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
      }),
    );

    const model = buildToday({
      rounds: [...repoARounds, ...repoBRounds, ...repoCRounds],
      prs: [],
      findings: [],
      fleet: emptyFleet,
      now,
    });

    const denialAnomalies = model.anomalies.filter((a) => a.id.startsWith("denials:"));
    expect(denialAnomalies.map((a) => a.repository)).toEqual(["acme/alpha"]);
  });

  it("week stats compare this week with the previous 7 days", () => {
    // 3 rounds this week
    const thisWeekRounds = [
      makeRound({ session_id: "w1", pr_number: 1, recorded_at: new Date(now.getTime() - 2 * DAY_MS).toISOString() }),
      makeRound({ session_id: "w2", pr_number: 2, recorded_at: new Date(now.getTime() - 3 * DAY_MS).toISOString() }),
      makeRound({ session_id: "w3", pr_number: 3, recorded_at: new Date(now.getTime() - 4 * DAY_MS).toISOString() }),
    ];
    // 1 round last week
    const lastWeekRounds = [
      makeRound({ session_id: "p1", pr_number: 4, recorded_at: new Date(now.getTime() - 10 * DAY_MS).toISOString() }),
    ];

    const model = buildToday({
      rounds: [...thisWeekRounds, ...lastWeekRounds],
      prs: [],
      findings: [],
      fleet: emptyFleet,
      now,
    });

    const roundsStat = model.week.find((w) => w.label === "Rounds");
    expect(roundsStat).toBeDefined();
    expect(roundsStat!.value).toBe(3);
    expect(roundsStat!.previous).toBe(1);

    const prsStat = model.week.find((w) => w.label === "Pull requests reviewed");
    expect(prsStat).toBeDefined();
    expect(prsStat!.value).toBe(3);
    expect(prsStat!.previous).toBe(1);
  });

  it("malformed_configs produce a problem sentence", () => {
    const fleet: FleetReposResponse = {
      ...emptyFleet,
      malformed_configs: [
        { repository: "acme/service", layer: "repo" },
      ],
    };

    const model = buildToday({
      rounds: [],
      prs: [],
      findings: [],
      fleet,
      now,
    });

    expect(model.problems).toContain(
      "acme/service: its repo config layer is malformed, so the lane runs on workflow defaults.",
    );
  });
  it("withholds p95 and cache hit under their minimum n and says why", () => {
    const rounds = Array.from({ length: 5 }, () => makeRound());
    const model = buildToday({ rounds, prs: [makePr()], findings: [], fleet: emptyFleet, now });
    const p95 = model.week.find((w) => w.label === "p95 round time")!;
    const cache = model.week.find((w) => w.label === "Cache hit")!;
    expect(p95.value).toBeNull();
    expect(p95.note).toContain("p95 needs 20");
    expect(cache.value).toBeNull();
    expect(cache.note).toContain("5 rounds carry token counts");
  });

  it("leaves rounds without token counts out of the cache ratio and says so", () => {
    const rounds = [
      ...Array.from({ length: 10 }, () => makeRound()),
      makeRound({ input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null }),
    ];
    const model = buildToday({ rounds, prs: [makePr()], findings: [], fleet: emptyFleet, now });
    const cache = model.week.find((w) => w.label === "Cache hit")!;
    expect(cache.value).toBeCloseTo(0.25);
    expect(cache.note).toBe("1 of 11 rounds lack token counts and are left out");
  });

  it("names denials not recorded instead of counting them as zero", () => {
    const rounds = [makeRound({ permission_denials: null }), makeRound({ permission_denials: null })];
    const model = buildToday({ rounds, prs: [makePr()], findings: [], fleet: emptyFleet, now });
    expect(model.repos[0]!.denials).toBeNull();
    expect(model.repos[0]!.denialRounds).toBe(0);
  });

  it("rates denials over recorded rounds only", () => {
    const rounds = [
      ...Array.from({ length: 10 }, () => makeRound({ permission_denials: 3 })),
      ...Array.from({ length: 10 }, () => makeRound({ permission_denials: null })),
    ];
    const model = buildToday({ rounds, prs: [makePr()], findings: [], fleet: emptyFleet, now });
    expect(model.repos[0]!.state).toBe("tool denials");
    expect(model.anomalies.find((a) => a.id === "denials:acme/web")?.detail).toContain("3.0 denials a round");
  });
  it("withholds the denial rate below LOW_N_THRESHOLD recorded rounds but keeps the count", () => {
    const model = buildToday({ rounds: [makeRound({ permission_denials: 20 })], prs: [makePr()], findings: [], fleet: emptyFleet, now });
    expect(model.anomalies.filter((a) => a.id.startsWith("denials:"))).toEqual([]);
    expect(model.repos[0]!.state).toBe("reviewing");
    expect(model.repos[0]!.denials).toBe(20);
  });

  it("marks the earlier week withheld when it has too few rounds for p95", () => {
    const rounds = [
      ...Array.from({ length: 20 }, () => makeRound()),
      ...Array.from({ length: 3 }, () => makeRound({ recorded_at: new Date(now.getTime() - 10 * DAY_MS).toISOString() })),
    ];
    const model = buildToday({ rounds, prs: [makePr()], findings: [], fleet: emptyFleet, now });
    const p95 = model.week.find((w) => w.label === "p95 round time")!;
    expect(p95.value).not.toBeNull();
    expect(p95.previous).toBeNull();
    expect(p95.previousWithheld).toBe(true);
  });
});
