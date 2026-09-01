import { describe, expect, it } from "vitest";

import type { ChangeRow, RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import {
  compareDerivedMetric,
  compareMeanMetric,
  compareP95Metric,
  compareRoundTypes,
  splitRoundsByChange,
} from "./compare";
import { cacheHitRate } from "@/honesty/aggregate";
import { P95_MIN_N } from "@/honesty/thresholds";

const sampleChange: ChangeRow = {
  id: "change-1",
  name: "Upgrade reviewer to Claude 3.7 Sonnet",
  at: "2026-08-15T12:00:00.000Z",
  source_url: "https://github.com/prismalens/gh-workflows/pull/73",
  scope: "fleet",
  repository: null,
  created_at: "2026-08-15T12:05:00.000Z",
};

const seq = (n: number) => Array.from({ length: n }, (_, i) => (i + 1) * 1000);

describe("splitRoundsByChange: strict window partitioning", () => {
  it("splits rounds before and after change's at timestamp", () => {
    const rows: RoundRow[] = [
      { ...makeRounds({ count: 1 })[0], recorded_at: "2026-08-10T00:00:00.000Z" },
      { ...makeRounds({ count: 1 })[0], recorded_at: "2026-08-15T11:59:59.000Z" },
      { ...makeRounds({ count: 1 })[0], recorded_at: "2026-08-15T12:00:00.000Z" },
      { ...makeRounds({ count: 1 })[0], recorded_at: "2026-08-20T00:00:00.000Z" },
    ];

    const { beforeRows, afterRows } = splitRoundsByChange(rows, sampleChange);
    expect(beforeRows).toHaveLength(2);
    expect(afterRows).toHaveLength(2);
    expect(beforeRows.map((r) => r.recorded_at)).toEqual([
      "2026-08-10T00:00:00.000Z",
      "2026-08-15T11:59:59.000Z",
    ]);
    expect(afterRows.map((r) => r.recorded_at)).toEqual([
      "2026-08-15T12:00:00.000Z",
      "2026-08-20T00:00:00.000Z",
    ]);
  });

  it("applies repository filter when change is repo-scoped", () => {
    const repoChange: ChangeRow = {
      ...sampleChange,
      scope: "repo",
      repository: "prismalens/gh-workflows",
    };
    const rows: RoundRow[] = [
      {
        ...makeRounds({ count: 1 })[0],
        repository: "prismalens/gh-workflows",
        recorded_at: "2026-08-10T00:00:00.000Z",
      },
      {
        ...makeRounds({ count: 1 })[0],
        repository: "other/repo",
        recorded_at: "2026-08-10T00:00:00.000Z",
      },
      {
        ...makeRounds({ count: 1 })[0],
        repository: "prismalens/gh-workflows",
        recorded_at: "2026-08-20T00:00:00.000Z",
      },
    ];

    const { beforeRows, afterRows } = splitRoundsByChange(rows, repoChange);
    expect(beforeRows).toHaveLength(1);
    expect(afterRows).toHaveLength(1);
    expect(beforeRows[0].repository).toBe("prismalens/gh-workflows");
    expect(afterRows[0].repository).toBe("prismalens/gh-workflows");
  });
});

describe("Refusal 1: Deltas are coloured only when both sides clear n=10", () => {
  it("keeps deltas uncoloured when before has n < 10", () => {
    const before = seq(9);
    const after = seq(15);
    const res = compareMeanMetric(before, after, false);
    expect(res.kind).toBe("compared");
    if (res.kind === "compared") {
      expect(res.lowN).toBe(true);
      expect(res.deltaColor).toBe("uncoloured");
    }
  });

  it("keeps deltas uncoloured when after has n < 10", () => {
    const before = seq(15);
    const after = seq(8);
    const res = compareMeanMetric(before, after, false);
    expect(res.kind).toBe("compared");
    if (res.kind === "compared") {
      expect(res.lowN).toBe(true);
      expect(res.deltaColor).toBe("uncoloured");
    }
  });

  it("colours deltas as improvement or regression when both sides clear n=10", () => {
    const before = seq(12); // mean = 6500
    const afterFaster = before.map((v) => v * 0.5); // mean = 3250 (faster, lower wall clock)
    const afterSlower = before.map((v) => v * 1.5); // mean = 9750 (slower, higher wall clock)

    const imp = compareMeanMetric(before, afterFaster, false);
    expect(imp.kind).toBe("compared");
    if (imp.kind === "compared") {
      expect(imp.lowN).toBe(false);
      expect(imp.deltaColor).toBe("improvement");
    }

    const reg = compareMeanMetric(before, afterSlower, false);
    expect(reg.kind).toBe("compared");
    if (reg.kind === "compared") {
      expect(reg.lowN).toBe(false);
      expect(reg.deltaColor).toBe("regression");
    }
  });

  it("colours derived metrics (higher is better) appropriately above n=10", () => {
    const makeTokenRows = (count: number, hitRatio: number): RoundRow[] =>
      Array.from({ length: count }, () => ({
        ...makeRounds({ count: 1 })[0],
        input_tokens: 1000,
        cache_read_input_tokens: Math.round(1000 * hitRatio),
        cache_creation_input_tokens: Math.round(1000 * (1 - hitRatio)),
      }));

    const before = makeTokenRows(12, 0.4);
    const afterBetter = makeTokenRows(15, 0.8);
    const afterWorse = makeTokenRows(15, 0.2);

    const imp = compareDerivedMetric(cacheHitRate, cacheHitRate, before, afterBetter, true);
    expect(imp.kind).toBe("compared");
    if (imp.kind === "compared") {
      expect(imp.lowN).toBe(false);
      expect(imp.deltaColor).toBe("improvement");
    }

    const reg = compareDerivedMetric(cacheHitRate, cacheHitRate, before, afterWorse, true);
    expect(reg.kind).toBe("compared");
    if (reg.kind === "compared") {
      expect(reg.lowN).toBe(false);
      expect(reg.deltaColor).toBe("regression");
    }
  });
});

describe("Refusal 2: p95 comparison refused when either side is under n=20", () => {
  it("refuses comparison when both sides have n < 20 and names both short sides and their ns", () => {
    const before = seq(14);
    const after = seq(8);
    const res = compareP95Metric(before, after);
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") {
      expect(res.reason).toBe(
        `p95 comparison refused: before window has n = 14 and after window has n = 8 (both require n ≥ ${P95_MIN_N})`,
      );
      expect(res.beforeN).toBe(14);
      expect(res.afterN).toBe(8);
    }
  });

  it("refuses comparison when before has n < 20 and names before side and its n", () => {
    const before = seq(15);
    const after = seq(25);
    const res = compareP95Metric(before, after);
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") {
      expect(res.reason).toBe(
        `p95 comparison refused: before window has n = 15 (requires n ≥ ${P95_MIN_N})`,
      );
      expect(res.beforeN).toBe(15);
      expect(res.afterN).toBe(25);
    }
  });

  it("refuses comparison when after has n < 20 and names after side and its n", () => {
    const before = seq(22);
    const after = seq(12);
    const res = compareP95Metric(before, after);
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") {
      expect(res.reason).toBe(
        `p95 comparison refused: after window has n = 12 (requires n ≥ ${P95_MIN_N})`,
      );
      expect(res.beforeN).toBe(22);
      expect(res.afterN).toBe(12);
    }
  });

  it("compares p95 when both sides have n >= 20", () => {
    const before = seq(25);
    const after = seq(30).map((v) => v * 0.8);
    const res = compareP95Metric(before, after);
    expect(res.kind).toBe("compared");
    if (res.kind === "compared") {
      expect(res.beforeN).toBe(25);
      expect(res.afterN).toBe(30);
      expect(res.deltaColor).toBe("improvement");
    }
  });
});

describe("Refusal 3: Round types are compared separately and never pooled", () => {
  it("compares each round type independently and reports single-sided types", () => {
    const beforeRows: RoundRow[] = [
      ...Array.from({ length: 15 }, () => ({
        ...makeRounds({ count: 1 })[0],
        round_type: "review",
        duration_ms: 5000,
      })),
      ...Array.from({ length: 5 }, () => ({
        ...makeRounds({ count: 1 })[0],
        round_type: "legacy-round",
        duration_ms: 8000,
      })),
    ];

    const afterRows: RoundRow[] = [
      ...Array.from({ length: 20 }, () => ({
        ...makeRounds({ count: 1 })[0],
        round_type: "review",
        duration_ms: 4000,
      })),
      ...Array.from({ length: 12 }, () => ({
        ...makeRounds({ count: 1 })[0],
        round_type: "incremental",
        duration_ms: 2000,
      })),
    ];

    const results = compareRoundTypes(beforeRows, afterRows);
    expect(results).toHaveLength(3);

    // incremental: after-only
    const inc = results.find((r) => r.roundType === "incremental")!;
    expect(inc.status).toBe("after-only");
    expect(inc.beforeCount).toBe(0);
    expect(inc.afterCount).toBe(12);
    expect(inc.explanation).toContain("Present after change (n = 12), absent before change (n = 0)");

    // legacy-round: before-only
    const leg = results.find((r) => r.roundType === "legacy-round")!;
    expect(leg.status).toBe("before-only");
    expect(leg.beforeCount).toBe(5);
    expect(leg.afterCount).toBe(0);
    expect(leg.explanation).toContain("Present before change (n = 5), absent after change (n = 0)");

    // review: both
    const rev = results.find((r) => r.roundType === "review")!;
    expect(rev.status).toBe("both");
    expect(rev.beforeCount).toBe(15);
    expect(rev.afterCount).toBe(20);
    expect(rev.meanWallClock?.kind).toBe("compared");
    expect(rev.p95WallClock?.kind).toBe("refused"); // before has 15 (< 20)
    if (rev.p95WallClock?.kind === "refused") {
      expect(rev.p95WallClock.reason).toContain("before window has n = 15");
    }
  });
});

describe("Refusal 4: Empty sides report in words", () => {
  it("compareMeanMetric refuses when either side has 0 rounds", () => {
    const emptyBefore = compareMeanMetric([], seq(10));
    expect(emptyBefore).toEqual({
      kind: "refused",
      reason: "No rounds before change to compare",
      beforeN: 0,
      afterN: 10,
    });

    const emptyAfter = compareMeanMetric(seq(10), []);
    expect(emptyAfter).toEqual({
      kind: "refused",
      reason: "No rounds after change to compare",
      beforeN: 10,
      afterN: 0,
    });
  });
});
