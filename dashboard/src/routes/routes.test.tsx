import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PrRow } from "@/api/types";
import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { LIST_RATE_EQUIVALENT } from "@/honesty/thresholds";
import { renderRoute } from "@/test/renderRoute";

// Rounds are laid out backwards from the moment the test runs, so the rolling
// window covers the same rows whatever day CI happens to run on.
const now = new Date();
const fullApi = makeFixtureApi(makeRounds({ count: 64, now }));
const sparseApi = makeFixtureApi(makeRounds({ count: 6, now, seed: 11 }));
const emptyApi = makeFixtureApi([]);

describe("/ overview: the altitude ruling", () => {
  it("puts throughput and adoption first, and the verdict strip directly under it", async () => {
    renderRoute({ path: "/", api: fullApi });

    const band = await screen.findByTestId("activity-band");
    const strip = screen.getByTestId("verdict-strip");
    const health = screen.getByText("Lane health");

    // DOCUMENT_POSITION_FOLLOWING: the band comes before the strip, and the strip
    // before lane health. Diagnostics never lead this page.
    expect(band.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(health) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(within(band).getByText("PRs reviewed")).toBeInTheDocument();
    expect(within(band).getByText("Review rounds")).toBeInTheDocument();
    expect(within(band).getByText("Repositories")).toBeInTheDocument();
    expect(within(band).getByText("Rounds per day, by type")).toBeInTheDocument();
  });

  it("headlines counts even at a volume that withholds every aggregate tile", async () => {
    const api = makeFixtureApi(makeRounds({ count: 4, now, seed: 3 }));
    renderRoute({ path: "/", api });

    const band = await screen.findByTestId("activity-band");
    expect(within(band).getAllByTestId("count-tile")).toHaveLength(3);
    // A count is true at any n. A mean over four rounds is not.
    expect(screen.getByText(/the table below is the summary/)).toBeInTheDocument();
    expect(screen.queryByTestId("tile-n")).not.toBeInTheDocument();
    // And the table that notice names is actually there, with all four rounds.
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getAllByRole("row").length).toBe(5);
  });

  it("switches only the supporting line on volume, at the ruled threshold", async () => {
    const thin = makeFixtureApi(makeRounds({ count: 12, now, seed: 7 }));
    renderRoute({ path: "/", api: thin });
    expect(await screen.findByText(/12 rounds all time/)).toBeInTheDocument();
    expect(screen.queryByText(/\/day mean/)).not.toBeInTheDocument();

    cleanup();
    renderRoute({ path: "/", api: fullApi });
    expect((await screen.findAllByText(/\/day mean/)).length).toBeGreaterThan(0);
  });

  it("buckets the verdict strip straight from verdict_kind, six ways, and the buckets sum to n (#141)", async () => {
    const baseRound = makeRounds({ count: 1, now })[0];
    const sixBucketRounds = [
      {
        ...baseRound,
        session_id: "vb-1",
        verdict_kind: "reviewed",
        recorded_at: new Date(now.getTime() - 6 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "vb-2",
        verdict_kind: "verify-rechecked",
        recorded_at: new Date(now.getTime() - 5 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "vb-3",
        verdict_kind: "auto-paused",
        recorded_at: new Date(now.getTime() - 4 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "vb-4",
        verdict_kind: "silent",
        recorded_at: new Date(now.getTime() - 3 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "vb-5",
        verdict_kind: "error",
        recorded_at: new Date(now.getTime() - 2 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "vb-6",
        verdict_kind: null,
        recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
      },
    ];

    renderRoute({ path: "/", api: makeFixtureApi(sixBucketRounds) });
    const strip = await screen.findByTestId("verdict-strip");

    const labels = [
      "reviewed",
      "threads-only",
      "did-not-run",
      "silent",
      "error",
      "no verdict recorded",
    ];
    let total = 0;
    for (const label of labels) {
      const segment = within(strip).getByText(label);
      const count = Number(segment.querySelector(".font-medium")?.textContent);
      expect(count).toBe(1);
      total += count;
    }
    expect(total).toBe(6);
    expect(within(strip).getByText("n = 6")).toBeInTheDocument();
    expect(within(strip).getByTestId("approximate")).toBeInTheDocument();
  });

  it("carries only the attention cards the recorded columns support", async () => {
    renderRoute({ path: "/", api: fullApi });
    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
    const reasons = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[3]?.textContent ?? "");
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).toMatch(/permission denial|attempt \d|reported an error/);
    }
    const degraded = screen
      .getAllByTestId("degraded")
      .find((node) => node.textContent?.includes("Silent rounds"));
    expect(degraded).toHaveAttribute("data-reason", "unbuilt");
  });

  it("keeps money out of every headline on the overview", async () => {
    renderRoute({ path: "/", api: fullApi });
    await screen.findByTestId("activity-band");
    // No tile at any altitude, and at this volume no table either.
    expect(document.body.textContent).not.toMatch(/\$\d/);
    expect(document.body.textContent).not.toMatch(new RegExp(LIST_RATE_EQUIVALENT, "i"));

    cleanup();
    // At thin volume the round table replaces the tiles, and there money is a
    // sortable column labelled list-rate equivalent. That is the ruling, not a leak.
    renderRoute({ path: "/", api: makeFixtureApi(makeRounds({ count: 4, now, seed: 3 })) });
    const table = (await screen.findAllByRole("table"))[0];
    expect(within(table).getByText(LIST_RATE_EQUIVALENT)).toBeInTheDocument();
    for (const tile of screen.getAllByTestId("count-tile")) {
      expect(tile.textContent).not.toMatch(/\$/);
    }
  });

  it("widens only the range, keeping the repository filter it names in the copy", async () => {
    // The alert says "for <repo>", so the remedy beside it must not quietly widen
    // the repository filter too. An object-form Link search would replace the whole
    // search state and drop it.
    renderRoute({ path: "/?range=90d&repository=prismalens%2Fsreforge", api: emptyApi });
    const widen = await screen.findByRole("link", { name: "Widen to all time" });
    const href = widen.getAttribute("href") ?? "";
    expect(href).toContain("range=all");
    expect(decodeURIComponent(href)).toContain("repository=prismalens/sreforge");
  });

  it("says no rounds in range rather than drawing empty charts", async () => {
    renderRoute({ path: "/", api: emptyApi });
    expect(await screen.findByText("No rounds in range")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-band")).not.toBeInTheDocument();
    expect(screen.queryByTestId("verdict-strip")).not.toBeInTheDocument();
  });
});

describe("/repos", () => {
  it("lists what has posted, with its last round and last decoded state", async () => {
    renderRoute({ path: "/repos", api: fullApi });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("reviewed").length).toBeGreaterThan(0);
    for (const repository of [
      "prismalens/prismalens",
      "prismalens/sreforge",
      "Sumit1993/mage-memory",
    ]) {
      expect(within(table).getByText(repository)).toBeInTheDocument();
    }
  });

  it("keeps a repository that posted nothing in the window on the list", async () => {
    // One repository's rounds reach the table; the summary still knows all three
    // have posted, which is the denominator that must not silently shrink.
    const base = makeFixtureApi(makeRounds({ count: 64, now }));
    const oneRepo = {
      ...base,
      fetchRuns: async (query?: Parameters<typeof base.fetchRuns>[0]) => {
        const page = await base.fetchRuns(query);
        return {
          ...page,
          rows: page.rows.filter((row) => row.repository === "prismalens/prismalens"),
        };
      },
    };
    renderRoute({ path: "/repos", api: oneRepo });
    const table = await screen.findByRole("table");
    expect(within(table).getByText("prismalens/sreforge")).toBeInTheDocument();
    expect(within(table).getAllByText(/no round over/).length).toBeGreaterThan(0);
  });

  it("waits for the all-time list before drawing a denominator it would get wrong", async () => {
    // The two queries resolve independently and rounds win the race. Without the
    // gate, the render that commits the rounds data draws a list built from the
    // window alone: every quiet repository dropped and the count under-reporting,
    // with nothing on screen saying so.
    const base = makeFixtureApi(makeRounds({ count: 64, now }));
    let roundsSettled = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowSummary = {
      ...base,
      fetchRuns: async (query?: Parameters<typeof base.fetchRuns>[0]) => {
        const page = await base.fetchRuns(query);
        roundsSettled = true;
        return page;
      },
      fetchSummary: async () => {
        await held;
        return base.fetchSummary();
      },
    };

    renderRoute({ path: "/repos", api: slowSummary });
    await waitFor(() => expect(roundsSettled).toBe(true));
    // Let React commit the rounds result. This is the render the gate has to hold.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading repositories")).toBeInTheDocument();

    release();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("prismalens/sreforge")).toBeInTheDocument();
  });

  it("surfaces a failed summary instead of a silently short list", async () => {
    const base = makeFixtureApi(makeRounds({ count: 64, now }));
    const brokenSummary = {
      ...base,
      fetchSummary: async () => {
        throw new Error("summary route is down");
      },
    };

    renderRoute({ path: "/repos", api: brokenSummary });
    expect(await screen.findByText("Could not load repositories")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says the denominator is what has posted, not what is configured", async () => {
    renderRoute({ path: "/repos", api: fullApi });
    expect(
      await screen.findByText(/ever posted a round, which is not the same/),
    ).toBeInTheDocument();
    const degraded = screen
      .getAllByTestId("degraded")
      .find((node) => node.textContent?.includes("Lane, key mode and config"));
    expect(degraded).toHaveAttribute("data-reason", "unbuilt");
  });

  it("falls back to the default range on a marker range it cannot resolve (#104 finding 1)", async () => {
    renderRoute({ path: "/repos?range=marker:c1..c2", api: fullApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rolling" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("a fixtures build says the rounds are invented", () => {
  it("shows a persistent banner whenever the fixture table is behind the page", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    expect(await screen.findByTestId("fixture-banner")).toHaveTextContent(
      /every round on this page is invented/i,
    );
  });
});

describe("/rounds", () => {
  it("renders the table against fixture data", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
    expect(screen.getAllByText("prismalens/sreforge").length).toBeGreaterThan(0);
  });

  it("puts n on the footer's aggregates (#141)", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    const footerN = await screen.findByTestId("rounds-footer-n");
    expect(footerN).toHaveTextContent(/^n = \d+$/);
  });

  it("labels total_cost_usd as the list-rate equivalent and keeps money out of the footer", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    const table = await screen.findByRole("table");
    expect(within(table).getByText(LIST_RATE_EQUIVALENT)).toBeInTheDocument();

    const footerN = await screen.findByTestId("rounds-footer-n");
    const footerRow = footerN.closest("tr");
    expect(footerRow?.textContent).not.toMatch(/\$/);
    expect(footerRow?.textContent).not.toMatch(/cost|usd/i);
  });

  it("offers four range buttons and no date picker", async () => {
    const { container } = renderRoute({ path: "/rounds", api: fullApi });
    const group = await screen.findByRole("group", { name: "Range" });
    expect(within(group).getAllByRole("button")).toHaveLength(4);
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it("reads the range out of the URL, so a filtered view is shareable", async () => {
    renderRoute({ path: "/rounds?range=90d&repository=prismalens%2Fsreforge", api: fullApi });
    expect(await screen.findByText(/Over the last 90 days/)).toBeInTheDocument();
    const rows = await screen.findAllByRole("row");
    const repositories = rows
      .slice(1)
      .map((row) => within(row).queryByText(/^[\w-]+\/[\w-]+$/)?.textContent)
      .filter(Boolean);
    expect(new Set(repositories)).toEqual(new Set(["prismalens/sreforge"]));
  });

  it("falls back to the default range when the URL carries a bad one", async () => {
    renderRoute({ path: "/rounds?range=last-tuesday", api: fullApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rolling" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("falls back to the default range on a marker range it cannot resolve (#104 finding 1)", async () => {
    renderRoute({ path: "/rounds?range=marker:c1..c2", api: fullApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rolling" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders the round table and its pager at a thin range, no aggregate tiles at all (#141)", async () => {
    renderRoute({ path: "/rounds", api: sparseApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByTestId("tile-strip")).not.toBeInTheDocument();
    // Six fixture rows fit on one page: the count line shows, the nav does not.
    expect(screen.getByText("rows 1 to 6 of 6")).toBeInTheDocument();
    expect(screen.queryByText("Previous")).not.toBeInTheDocument();
  });

  it("says no rounds in range rather than showing zeros", async () => {
    renderRoute({ path: "/rounds", api: emptyApi });
    expect((await screen.findAllByText("No rounds in range")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("page and size round-trip through the URL (#141)", async () => {
    // 64 rows, range=all so the window is exactly the fetched set: two pages of 50.
    renderRoute({ path: "/rounds?range=all&size=50&page=2", api: fullApi });
    expect(await screen.findByText("rows 51 to 64 of 64")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "50" })).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(14);
  });

  it("a page beyond the last clamps to the last (#141)", async () => {
    renderRoute({ path: "/rounds?range=all&page=999", api: fullApi });
    // 64 rows at the default size of 25: three pages, the last holding 14 rows.
    expect(await screen.findByText("rows 51 to 64 of 64")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(14);
    expect(screen.getByText("Next")).toBeDisabled();
  });

  it("every filter, the search term, the sort and the page survive a reload (#141)", async () => {
    const baseRoundForUrlTest = makeRounds({ count: 1, now })[0];
    const target1 = {
      ...baseRoundForUrlTest,
      session_id: "url-target-aaa",
      pr_number: 555,
      repository: "prismalens/sreforge",
      round_type: "full",
      verdict_kind: "clean",
      job_conclusion: "success",
      model: "claude-opus-4-6",
      duration_ms: 5000,
      recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
    };
    const target2 = {
      ...target1,
      session_id: "url-target-bbb",
      pr_number: 556,
      duration_ms: 3000,
      recorded_at: new Date(now.getTime() - 2 * 3600000).toISOString(),
    };
    const wrongRepo = {
      ...target1,
      session_id: "url-target-ccc",
      pr_number: 557,
      repository: "prismalens/prismalens",
    };
    const wrongType = {
      ...target1,
      session_id: "url-target-ddd",
      pr_number: 558,
      round_type: "verify",
    };
    const wrongVerdict = {
      ...target1,
      session_id: "url-target-eee",
      pr_number: 559,
      verdict_kind: "error",
      job_conclusion: "failure",
    };
    const wrongModel = {
      ...target1,
      session_id: "url-target-fff",
      pr_number: 560,
      model: "claude-sonnet-4-6",
    };
    const wrongSearch = {
      ...target1,
      session_id: "url-other-ggg",
      pr_number: 561,
    };
    const api = makeFixtureApi([
      target1,
      target2,
      wrongRepo,
      wrongType,
      wrongVerdict,
      wrongModel,
      wrongSearch,
    ]);

    const url =
      "/rounds?range=all&repository=prismalens%2Fsreforge&round_type=full&verdict=reviewed" +
      "&model=claude-opus-4-6&q=target&sort=duration_ms&dir=asc&page=1&size=50";
    renderRoute({ path: url, api });

    // repository + round_type narrow the window to 5 rows (excludes wrongRepo, wrongType);
    // verdict + model + q narrow further to the 2 target rows.
    expect(await screen.findByText("rows 1 to 2 of 2 matching, 5 in window")).toBeInTheDocument();
    const table = screen.getByRole("table");
    const rows = table.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    // sort=duration_ms&dir=asc: target2 (3000ms) sorts before target1 (5000ms).
    expect(within(rows[0] as HTMLElement).getByText("#556")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("#555")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "prismalens/sreforge" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "full" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "reviewed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "claude-opus-4-6" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "50" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("Search repository, PR, session, sha")).toHaveValue(
      "target",
    );
  });
});

describe("/rounds/$sessionId", () => {
  const rows = makeRounds({ count: 64, now });
  const api = makeFixtureApi(rows);
  const withFanOut = rows.find((row) => row.round_type === "incremental")!;
  const verify = rows.find((row) => row.round_type === "verify")!;

  const detailPath = (sessionId: string, at: string) =>
    `/rounds/${sessionId}?at=${encodeURIComponent(at)}`;

  it("renders all six panels", async () => {
    renderRoute({ path: detailPath(withFanOut.session_id, withFanOut.recorded_at), api });
    for (const title of [
      "Resolution",
      "Timing",
      "Fan-out",
      "Tokens",
      "Permission denials",
      "Raw record",
    ]) {
      expect(await screen.findByText(title)).toBeInTheDocument();
    }
  });

  it("labels the fan-out approximate and refuses to draw per-agent bars", async () => {
    renderRoute({ path: detailPath(withFanOut.session_id, withFanOut.recorded_at), api });
    expect(await screen.findByTestId("approximate")).toBeInTheDocument();
    const perAgent = (await screen.findAllByTestId("degraded")).find((node) =>
      node.textContent?.includes("Per-agent breakdown"),
    );
    expect(perAgent).toHaveAttribute("data-reason", "lane-did-not-send");
    expect(perAgent?.textContent ?? "").toContain("predates per-agent rows");
  });

  it("separates a field this lane left empty from one that is not built yet (#100)", async () => {
    // The fixture's verify rounds carry lane_version v2.0.0 and a null
    // subagent_stats, so the gap is "sent nothing", not "predates the field".
    renderRoute({ path: detailPath(verify.session_id, verify.recorded_at), api });
    const degraded = await screen.findAllByTestId("degraded");
    const subagentLifecycle = degraded.find((node) =>
      node.textContent?.includes("Subagent lifecycle counts"),
    );
    expect(subagentLifecycle).toHaveAttribute("data-reason", "lane-sent-nothing");
    const perAgent = degraded.find((node) => node.textContent?.includes("Per-agent breakdown"));
    expect(perAgent).toHaveAttribute("data-reason", "lane-did-not-send");
    expect(perAgent?.textContent ?? "").toContain("predates per-agent rows");
  });

  it("reads a fan-out round's summed API time as parallelism, never negative overhead", async () => {
    // The artboards show API time exceeding wall clock, because duration_api_ms is
    // summed across concurrent agents. Subtracting would render a negative duration.
    const parallel = { ...rows[0], duration_ms: 338_000, duration_api_ms: 493_000 };
    const one = makeFixtureApi([parallel]);
    renderRoute({ path: detailPath(parallel.session_id, parallel.recorded_at), api: one });

    expect(await screen.findByText("Parallelism")).toBeInTheDocument();
    expect(screen.getByText("1.46x")).toBeInTheDocument();
    expect(screen.queryByText("Outside the API")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/-\d+m/);
  });

  it("withholds the derived token figures on a partially recorded round", async () => {
    // The same rule tokenSums applies across rounds: a missing count summed as
    // zero would render "0.0%" and "1.00x" beside a dash for the same column.
    const partial = { ...rows[0], cache_read_input_tokens: null };
    const one = makeFixtureApi([partial]);
    renderRoute({ path: detailPath(partial.session_id, partial.recorded_at), api: one });

    const hitRate = (await screen.findByText("Cache hit rate")).parentElement;
    const multiplier = screen.getByText("Caching multiplier").parentElement;
    expect(hitRate).toHaveTextContent("—");
    expect(hitRate).not.toHaveTextContent("%");
    expect(multiplier).toHaveTextContent("—");
    expect(multiplier).not.toHaveTextContent("x");
  });

  it("still reports them when all three counts are present", async () => {
    const complete = rows.find((r) => r.cache_read_input_tokens !== null)!;
    const one = makeFixtureApi([complete]);
    renderRoute({ path: detailPath(complete.session_id, complete.recorded_at), api: one });

    const hitRate = (await screen.findByText("Cache hit rate")).parentElement;
    expect(hitRate).toHaveTextContent(/%/);
  });

  it("renders the denials panel when denial_tools arrives unusable", async () => {
    const broken = {
      ...rows[0],
      raw_result: JSON.stringify({ type: "result", denial_tools: 5 }),
    };
    const one = makeFixtureApi([broken]);
    renderRoute({ path: detailPath(broken.session_id, broken.recorded_at), api: one });

    expect(await screen.findByText("Permission denials")).toBeInTheDocument();
    const degraded = await screen.findAllByTestId("degraded");
    expect(
      degraded.some((node) => node.textContent?.includes("Which tools were denied")),
    ).toBe(true);
  });

  it("names the round, not rounds, while the detail route loads", async () => {
    const slow = { ...makeFixtureApi(rows), fetchRuns: () => new Promise<never>(() => {}) };
    renderRoute({ path: detailPath(rows[0].session_id, rows[0].recorded_at), api: slow });
    expect(await screen.findByLabelText("Loading this round")).toBeInTheDocument();
  });

  it("explains the bounded scan when the round is outside the readable window", async () => {
    renderRoute({ path: "/rounds/does-not-exist", api });
    expect(await screen.findByText(/not in the readable window/)).toBeInTheDocument();
  });
});

describe("a nulled column is absent, never smallest", () => {
  // duration_ms comes through unguarded from the workflow, so null is live data.
  const rows = makeRounds({ count: 12, now, seed: 5 });
  const withNulls = rows.map((row, i) =>
    i < 4
      ? {
          ...row,
          duration_ms: null,
          num_turns: null,
          permission_denials: null,
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
        }
      : row,
  );
  const api = makeFixtureApi(withNulls);

  // Column order: expander, recorded, repository, pr, type, verdict, model,
  // wall clock (#141 added verdict and model after type, shifting later columns).
  // Scoped to tbody so the #141 footer row (one cell spanning every column)
  // never counts as a data row here.
  const bodyRows = () => screen.getByRole("table").querySelectorAll("tbody tr");
  const wallClockColumn = () =>
    Array.from(bodyRows()).map((row) => row.querySelectorAll("td")[7]?.textContent?.trim() ?? "");

  it("sorts nulled wall clocks last, ascending and descending", async () => {
    renderRoute({ path: "/rounds?sort=duration_ms&dir=asc", api });
    await screen.findByRole("table");
    const asc = wallClockColumn();
    expect(asc.slice(-4)).toEqual(["—", "—", "—", "—"]);
    expect(asc[0]).not.toBe("—");

    cleanup();
    renderRoute({ path: "/rounds?sort=duration_ms&dir=desc", api });
    await screen.findByRole("table");
    const desc = wallClockColumn();
    expect(desc.slice(-4)).toEqual(["—", "—", "—", "—"]);
  });

  it("renders a missing token count as absent rather than as the lightest round", async () => {
    renderRoute({ path: "/rounds?sort=billable_tokens&dir=asc", api });
    await screen.findByRole("table");
    const tokens = Array.from(bodyRows()).map(
      (row) => row.querySelectorAll("td")[10]?.textContent?.trim() ?? "",
    );
    expect(tokens.slice(-4)).toEqual(["—", "—", "—", "—"]);
    expect(tokens).not.toContain("0");
  });

  it("sorts a nulled list-rate equivalent last too", async () => {
    renderRoute({ path: "/rounds?sort=total_cost_usd&dir=asc", api });
    await screen.findByRole("table");
    const costs = Array.from(bodyRows()).map(
      (row) => row.querySelectorAll("td")[11]?.textContent?.trim() ?? "",
    );
    expect(costs.slice(-4)).toEqual(["—", "—", "—", "—"]);
  });
});

describe("/failures route integration", () => {
  it("renders all five failure sections in fixed order", async () => {
    renderRoute({ path: "/failures", api: fullApi });
    const s1 = await screen.findByTestId("section-verdicts");
    const s2 = screen.getByTestId("section-fallbacks");
    const s3 = screen.getByTestId("section-configs");
    const s4 = screen.getByTestId("section-model-resolution");
    const s5 = screen.getByTestId("section-lane-events");

    expect(s1.compareDocumentPosition(s2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(s2.compareDocumentPosition(s3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(s3.compareDocumentPosition(s4) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(s4.compareDocumentPosition(s5) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers range control and repository filter without date picker", async () => {
    const { container } = renderRoute({ path: "/failures", api: fullApi });
    const group = await screen.findByRole("group", { name: "Range" });
    expect(within(group).getAllByRole("button")).toHaveLength(4);
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });

  it("falls back to the default range on a marker range it cannot resolve (#104 finding 1)", async () => {
    renderRoute({ path: "/failures?range=marker:c1..c2", api: fullApi });
    const group = await screen.findByRole("group", { name: "Range" });
    expect(within(group).getByRole("button", { name: "Rolling" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("surfaces a failed attention query instead of rendering config's empty state (#104 finding 5)", async () => {
    const base = makeFixtureApi(makeRounds({ count: 64, now }));
    const brokenAttention = {
      ...base,
      fetchRuns: (query: Parameters<typeof base.fetchRuns>[0]) => {
        if (query?.include === "blobs") throw new Error("attention route is down");
        return base.fetchRuns(query);
      },
    };

    renderRoute({ path: "/failures", api: brokenAttention });
    expect(await screen.findByText("Could not load failure surface telemetry")).toBeInTheDocument();
    expect(
      screen.queryByText("No configuration resolution records found in the loaded window."),
    ).not.toBeInTheDocument();
  });
});

describe("/ overview: change markers on the trend charts", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const t0 = now.getTime();

  const changeFleetIn = {
    id: "c-fleet-in",
    name: "Upgrade reviewer to Claude 3.7 Sonnet",
    at: new Date(t0 - 3 * dayMs).toISOString(),
    source_url: null,
    scope: "fleet" as const,
    repository: null,
    created_at: new Date(t0 - 3 * dayMs).toISOString(),
  };

  const changeFleetOut = {
    id: "c-fleet-out",
    name: "Ancient fleet change",
    at: new Date(t0 - 45 * dayMs).toISOString(),
    source_url: null,
    scope: "fleet" as const,
    repository: null,
    created_at: new Date(t0 - 45 * dayMs).toISOString(),
  };

  const changeRepoSreforge = {
    id: "c-repo-sreforge",
    name: "Sreforge review rule update",
    at: new Date(t0 - 4 * dayMs).toISOString(),
    source_url: null,
    scope: "repo" as const,
    repository: "prismalens/sreforge",
    created_at: new Date(t0 - 4 * dayMs).toISOString(),
  };

  const changeRepoOther = {
    id: "c-repo-other",
    name: "Mage memory model switch",
    at: new Date(t0 - 4 * dayMs).toISOString(),
    source_url: null,
    scope: "repo" as const,
    repository: "Sumit1993/mage-memory",
    created_at: new Date(t0 - 4 * dayMs).toISOString(),
  };

  const changeAlpha = {
    id: "c-alpha",
    name: "Alpha deployment",
    at: new Date(t0 - 5 * dayMs).toISOString(),
    source_url: null,
    scope: "fleet" as const,
    repository: null,
    created_at: new Date(t0 - 5 * dayMs).toISOString(),
  };

  const changeBeta = {
    id: "c-beta",
    name: "Beta deployment",
    at: new Date(t0 - 2 * dayMs).toISOString(),
    source_url: null,
    scope: "fleet" as const,
    repository: null,
    created_at: new Date(t0 - 2 * dayMs).toISOString(),
  };

  it("with no changes registered, the charts render as before and nothing marker-related appears", async () => {
    const api = makeFixtureApi(makeRounds({ count: 20, now }), [], []);
    renderRoute({ path: "/", api });

    await screen.findByTestId("activity-band");
    expect(screen.getByText("Rounds per day, by type")).toBeInTheDocument();
    expect(screen.getByText("Token composition by day")).toBeInTheDocument();
    expect(screen.getByText("Wall clock, every round")).toBeInTheDocument();

    expect(screen.queryByTestId("marker-selection-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^marker-/)).toBeNull();
    const rangeGroup = screen.getByRole("group", { name: "Range" });
    expect(within(rangeGroup).getAllByRole("button")).toHaveLength(4);
  });

  it("a fleet change inside the window draws a labelled marker; one outside the window does not", async () => {
    const api = makeFixtureApi(makeRounds({ count: 20, now }), [], [changeFleetIn, changeFleetOut]);
    renderRoute({ path: "/?range=30d", api });

    await screen.findByTestId("activity-band");
    const markers = await screen.findAllByText("Upgrade reviewer to Claude 3.7 Sonnet");
    expect(markers.length).toBeGreaterThan(0);
    expect(screen.queryByText("Ancient fleet change")).not.toBeInTheDocument();
  });

  it("a repo change draws only on a chart for that repository", async () => {
    const api = makeFixtureApi(
      makeRounds({ count: 20, now }),
      [],
      [changeFleetIn, changeRepoSreforge, changeRepoOther],
    );

    // On all-repos overview chart, repo-scoped changes do not draw
    renderRoute({ path: "/?range=30d", api });
    await screen.findByTestId("activity-band");
    expect(screen.getAllByText("Upgrade reviewer to Claude 3.7 Sonnet").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sreforge review rule update")).not.toBeInTheDocument();
    expect(screen.queryByText("Mage memory model switch")).not.toBeInTheDocument();

    cleanup();

    // On sreforge chart, only sreforge and fleet changes draw
    renderRoute({ path: "/?range=30d&repository=prismalens%2Fsreforge", api });
    await screen.findByTestId("activity-band");
    expect(screen.getAllByText("Upgrade reviewer to Claude 3.7 Sonnet").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sreforge review rule update").length).toBeGreaterThan(0);
    expect(screen.queryByText("Mage memory model switch")).not.toBeInTheDocument();
  });

  it("a change with no rounds after it still draws", async () => {
    // Rounds recorded between 10 days ago and 6 days ago
    const olderRounds = Array.from({ length: 15 }, (_, i) => ({
      ...makeRounds({ count: 1 })[0],
      session_id: `old-${i}`,
      round_type: "review",
      recorded_at: new Date(t0 - (10 - (i % 4)) * dayMs).toISOString(),
      duration_ms: 5000,
    }));
    // Change recorded 2 days ago (no rounds recorded after it)
    const lateChange = {
      id: "c-late",
      name: "Recent unmeasured change",
      at: new Date(t0 - 2 * dayMs).toISOString(),
      source_url: null,
      scope: "fleet" as const,
      repository: null,
      created_at: new Date(t0 - 2 * dayMs).toISOString(),
    };
    const api = makeFixtureApi(olderRounds, [], [lateChange]);

    renderRoute({ path: "/?range=30d", api });
    await screen.findByTestId("activity-band");
    const markerLabels = await screen.findAllByText("Recent unmeasured change");
    expect(markerLabels.length).toBeGreaterThan(0);
  });

  it("clicking one marker shows a visible selection; clicking a second sets marker:<a>..<b>; clicking the selected marker again clears it", async () => {
    const api = makeFixtureApi(makeRounds({ count: 20, now }), [], [changeAlpha, changeBeta]);
    renderRoute({ path: "/", api });

    await screen.findByTestId("activity-band");
    expect(screen.queryByTestId("marker-selection-banner")).not.toBeInTheDocument();

    // 1. Click changeAlpha -> shows visible selection banner and aria-selected
    fireEvent.click(screen.getAllByTestId("marker-c-alpha")[0]);
    await waitFor(() => {
      expect(screen.getByTestId("marker-selection-banner")).toHaveTextContent(
        /Selected marker:.*Alpha deployment/,
      );
      expect(screen.getAllByTestId("marker-c-alpha")[0]).toHaveAttribute("data-selected", "true");
    });

    // 2. Click changeAlpha again -> clears selection
    fireEvent.click(screen.getAllByTestId("marker-c-alpha")[0]);
    await waitFor(() => {
      expect(screen.queryByTestId("marker-selection-banner")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("marker-c-alpha")[0]).toHaveAttribute("data-selected", "false");
    });

    // 3. Click changeAlpha again, then click changeBeta -> sets range to marker:c-alpha..c-beta
    fireEvent.click(screen.getAllByTestId("marker-c-alpha")[0]);
    await waitFor(() => {
      expect(screen.getByTestId("marker-selection-banner")).toBeInTheDocument();
      expect(screen.getAllByTestId("marker-c-alpha")[0]).toHaveAttribute("data-selected", "true");
    });

    await waitFor(() => {
      fireEvent.click(screen.getAllByTestId("marker-c-beta")[0]);
      expect(screen.queryByTestId("marker-selection-banner")).not.toBeInTheDocument();
    });

    // Windowed label displays between
    const betweenLabels = await screen.findAllByText(
      /between "Alpha deployment" and "Beta deployment"/,
    );
    expect(betweenLabels.length).toBeGreaterThan(0);
  });

  it("the range control still offers exactly four buttons and no date input", async () => {
    const api = makeFixtureApi(makeRounds({ count: 20, now }), [], [changeAlpha, changeBeta]);
    const { container } = renderRoute({ path: "/?range=marker:c-alpha..c-beta", api });

    await screen.findByTestId("activity-band");
    const group = screen.getByRole("group", { name: "Range" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button).toHaveAttribute("aria-pressed", "false");
    }

    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  });
});

describe("/prs and /prs/$owner/$repo/$number route integration (#75)", () => {
  const baseRound = makeRounds({ count: 1, now })[0];

  const fourStateRounds = [
    {
      ...baseRound,
      session_id: "pr-s-1",
      pr_number: 201,
      pr_title: "PR with silent review failure",
      verdict_kind: "silent",
      round_type: "full",
      job_conclusion: "success",
      recorded_at: new Date(now.getTime() - 4 * 3600000).toISOString(),
    },
    {
      ...baseRound,
      session_id: "pr-s-2",
      pr_number: 202,
      pr_title: "PR that auto-paused at limit",
      verdict_kind: "auto-paused",
      round_ordinal: 3,
      round_type: "full",
      job_conclusion: "success",
      recorded_at: new Date(now.getTime() - 3 * 3600000).toISOString(),
    },
    {
      ...baseRound,
      session_id: "pr-s-3",
      pr_number: 203,
      pr_title: "PR with verify only",
      verdict_kind: "verify-rechecked",
      round_type: "verify",
      job_conclusion: "success",
      recorded_at: new Date(now.getTime() - 2 * 3600000).toISOString(),
    },
    {
      ...baseRound,
      session_id: "pr-s-4",
      pr_number: 204,
      pr_title: "PR fully reviewed and clean",
      verdict_kind: "reviewed",
      round_type: "full",
      job_conclusion: "success",
      recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
    },
  ];
  const fourStateApi = makeFixtureApi(fourStateRounds);

  it("renders the PR index table with rows against fixture data", async () => {
    renderRoute({ path: "/prs", api: fullApi });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Pull requests")).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(5);
  });

  it("head-status decode produces the right label for each of the four states", async () => {
    renderRoute({ path: "/prs", api: fourStateApi });
    const table = await screen.findByRole("table");

    // State 1: failed (silent) -> "failed: posted nothing"
    expect(within(table).getByText("failed: posted nothing")).toBeInTheDocument();

    // State 2: did-not-run -> "auto-paused (round 3)"
    expect(within(table).getByText("auto-paused (round 3)")).toBeInTheDocument();

    // State 3: threads-only -> "threads-only"
    expect(within(table).getByText("threads-only")).toBeInTheDocument();

    // State 4: reviewed -> "reviewed"
    expect(within(table).getByText("reviewed")).toBeInTheDocument();
  });

  it("the sort order puts unreviewed heads above reviewed-clean ones by default", async () => {
    renderRoute({ path: "/prs", api: fourStateApi });
    await screen.findByRole("table");

    const chips = screen.getAllByTestId("head-status-chip");
    const states = chips.map((c) => c.getAttribute("data-state"));

    // Sorted by attention: failed > did-not-run > threads-only > reviewed
    expect(states).toEqual(["failed", "did-not-run", "threads-only", "reviewed"]);

    // The reviewed (clean) head is last; all unreviewed heads are above it
    expect(states.indexOf("reviewed")).toBe(3);
  });

  it("page and size round-trip through the URL (#141)", async () => {
    // Repository cycles every 3 rounds and pr_number every 2, so a PR (keyed by
    // repository#number) rarely repeats: 64 rounds group into 64 distinct PRs.
    renderRoute({ path: "/prs?range=all&size=25&page=2", api: fullApi });
    await screen.findByRole("table");
    expect(screen.getByText("rows 26 to 50 of 64")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "25" })).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(25);
  });

  it("a page beyond the last clamps to the last (#141)", async () => {
    renderRoute({ path: "/prs?range=all&page=999", api: fullApi });
    await screen.findByRole("table");
    expect(screen.getByText("rows 51 to 64 of 64")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(14);
    expect(screen.getByText("Next")).toBeDisabled();
  });

  it("every filter, the search term, the sort and the page survive a reload (#141)", async () => {
    const base = makeRounds({ count: 1, now })[0];
    const target1 = {
      ...base,
      session_id: "pr-url-target-1",
      pr_number: 701,
      repository: "prismalens/sreforge",
      pr_state: "open",
      verdict_kind: "clean",
      job_conclusion: "success",
      round_type: "full",
      pr_title: "Target Alpha",
      pr_author: "alice",
      recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
    };
    const target2 = {
      ...target1,
      session_id: "pr-url-target-2",
      pr_number: 702,
      pr_title: "Target Beta",
      recorded_at: new Date(now.getTime() - 2 * 3600000).toISOString(),
    };
    const wrongState = {
      ...target1,
      session_id: "pr-url-target-3",
      pr_number: 703,
      pr_state: "closed",
      pr_title: "Target Gamma",
    };
    const wrongHeadStatus = {
      ...target1,
      session_id: "pr-url-target-4",
      pr_number: 704,
      verdict_kind: "error",
      job_conclusion: "failure",
      pr_title: "Target Delta",
    };
    const wrongSearch = {
      ...target1,
      session_id: "pr-url-other-5",
      pr_number: 705,
      pr_title: "Other Epsilon",
    };
    const api = makeFixtureApi([target1, target2, wrongState, wrongHeadStatus, wrongSearch]);

    const url =
      "/prs?range=all&repository=prismalens%2Fsreforge&state=open&head_status=reviewed" +
      "&q=target&sort=attention&dir=desc&page=1&size=50";
    renderRoute({ path: url, api });

    // state=open excludes wrongState; head_status+q narrow the remaining 4 down to 2.
    expect(await screen.findByText("rows 1 to 2 of 2 matching, 4 in window")).toBeInTheDocument();
    const table = screen.getByRole("table");
    const rows = table.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    // Both tie on attention rank; dir=desc reverses the default (most-recent-first) order.
    expect(within(rows[0] as HTMLElement).getByText("sreforge#702")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("sreforge#701")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "prismalens/sreforge" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const stateGroup = screen.getByRole("group", { name: "State" });
    expect(within(stateGroup).getByRole("button", { name: "open" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const headStatusGroup = screen.getByRole("group", { name: "Head status" });
    expect(within(headStatusGroup).getByRole("button", { name: "reviewed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "50" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("Search repository, PR, title, author")).toHaveValue(
      "target",
    );
  });

  it("renders detail route for a known PR with head banner and telemetry", async () => {
    const known = fourStateRounds[3]; // PR 204 (reviewed)
    const [owner, repo] = known.repository.split("/");
    renderRoute({
      path: `/prs/${owner}/${repo}/${known.pr_number}`,
      api: fourStateApi,
    });

    // PR header
    expect(await screen.findByText(new RegExp(`PR #${known.pr_number}`))).toBeInTheDocument();

    // Head banner answering "has this head been read"
    const banner = screen.getByTestId("head-banner");
    expect(banner).toHaveTextContent(/reviewed — the lane read this head commit/i);

    // Raw verdict string in monospace under it
    expect(screen.getByTestId("raw-verdict")).toBeInTheDocument();

    // Round timeline card
    expect(screen.getByTestId("round-timeline-card")).toBeInTheDocument();

    // Ladder, config, totals
    expect(screen.getByTestId("head-ladder-card")).toBeInTheDocument();
    expect(screen.getByTestId("config-in-effect-card")).toBeInTheDocument();
    expect(screen.getByTestId("pr-totals-card")).toBeInTheDocument();
    expect(screen.getByTestId("report-tabs")).toBeInTheDocument();
  });

  it("renders copyable unblock hint for amber/red states on detail route", async () => {
    const amber = fourStateRounds[1]; // PR 202 (auto-paused)
    const [owner, repo] = amber.repository.split("/");
    renderRoute({
      path: `/prs/${owner}/${repo}/${amber.pr_number}`,
      api: fourStateApi,
    });

    expect(await screen.findByText(new RegExp(`PR #${amber.pr_number}`))).toBeInTheDocument();
    const banner = screen.getByTestId("head-banner");
    expect(banner).toHaveTextContent(/not reviewed — auto-paused/i);

    const hint = screen.getByTestId("unblock-hint");
    expect(hint).toHaveTextContent("@claude review");
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("shows an empty state rather than crashing for an unknown PR", async () => {
    renderRoute({
      path: "/prs/prismalens/prismalens/99999",
      api: fullApi,
    });

    expect(await screen.findByText("This pull request was not found")).toBeInTheDocument();
    expect(screen.getByText(/no review rounds were found/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to pull requests" })).toBeInTheDocument();
  });

  it("/prs with no state parameter renders every state; an explicit state still filters (finding 3943781321, default reversed by #136)", async () => {
    const mixedStateRounds = [
      {
        ...baseRound,
        session_id: "pr-open-1",
        pr_number: 301,
        pr_title: "Active open PR",
        pr_state: "open",
        recorded_at: new Date(now.getTime() - 3 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "pr-merged-1",
        pr_number: 302,
        pr_title: "Completed merged PR",
        pr_state: "merged",
        recorded_at: new Date(now.getTime() - 2 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "pr-closed-1",
        pr_number: 303,
        pr_title: "Abandoned closed PR",
        pr_state: "closed",
        recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
      },
    ];
    const mixedApi = makeFixtureApi(mixedStateRounds);

    // Default route without ?state (#136): every state renders.
    renderRoute({ path: "/prs", api: mixedApi });
    await screen.findByRole("table");
    expect(screen.getByText("Active open PR")).toBeInTheDocument();
    expect(screen.getByText("Completed merged PR")).toBeInTheDocument();
    expect(screen.getByText("Abandoned closed PR")).toBeInTheDocument();
    const stateGroup = screen.getByRole("group", { name: "State" });
    expect(within(stateGroup).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // An explicit ?state=open still filters to just that state.
    cleanup();
    renderRoute({ path: "/prs?state=open", api: mixedApi });
    await screen.findByRole("table");
    expect(screen.getByText("Active open PR")).toBeInTheDocument();
    expect(screen.queryByText("Completed merged PR")).toBeNull();
    expect(screen.queryByText("Abandoned closed PR")).toBeNull();
  });

  it("reads title, state and author from the prs table, and mutes the round's guess otherwise (#136, #141)", async () => {
    const enrichedRound = {
      ...baseRound,
      session_id: "pr-prs-enriched",
      repository: "prismalens/sreforge",
      pr_number: 801,
      pr_title: "Stale round title",
      pr_author: "stale-author",
      pr_state: "open",
      recorded_at: new Date(now.getTime() - 2 * 3600000).toISOString(),
    };
    const fallbackRound = {
      ...baseRound,
      session_id: "pr-prs-fallback",
      repository: "prismalens/sreforge",
      pr_number: 802,
      pr_title: "",
      pr_state: "closed",
      recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
    };
    const prsRows: PrRow[] = [
      {
        repository: "prismalens/sreforge",
        pr_number: 801,
        state: "merged",
        title: "Current real title",
        author: "real-author",
        base_ref: "main",
        head_ref: "feature-801",
        head_sha: "abc123",
        merged_at: "2026-08-30T00:00:00.000Z",
        closed_at: null,
        updated_at: enrichedRound.recorded_at,
        source: "hook",
      },
    ];
    const api = makeFixtureApi([enrichedRound, fallbackRound], [], [], [], prsRows);

    renderRoute({ path: "/prs?range=all", api });
    const table = await screen.findByRole("table");

    // Enriched: real title and merged state replace the round's stale guess.
    expect(within(table).getByText("Current real title")).toBeInTheDocument();
    expect(within(table).getByText("merged")).toBeInTheDocument();
    expect(within(table).queryByText("Stale round title")).toBeNull();

    // Fallback: no prs row for 802, so the PR #n title and the round's
    // pr_state show up muted, with the "not refreshed" hint.
    expect(within(table).getByText("PR #802")).toBeInTheDocument();
    const fallbackState = within(table).getByText("closed", { selector: "span.italic" });
    expect(fallbackState).toHaveAttribute("title", "state at last round, not refreshed since");

    // The filter honours the enriched state: PR 801 shows only under merged.
    cleanup();
    renderRoute({ path: "/prs?range=all&state=merged", api });
    await screen.findByRole("table");
    expect(screen.getByText("Current real title")).toBeInTheDocument();
    expect(screen.queryByText("PR #802")).toBeNull();
  });

  it("'12abc' as a PR number is rejected rather than parsed as 12 (finding 3943781319)", async () => {
    const known = fourStateRounds[3]; // PR 204
    const [owner, repo] = known.repository.split("/");

    // Rejected malformed PR number (failure path)
    renderRoute({
      path: `/prs/${owner}/${repo}/${known.pr_number}abc`,
      api: fourStateApi,
    });
    expect(await screen.findByText("This pull request was not found")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`PR #${known.pr_number}`))).toBeNull();

    // Valid positive decimal integer PR number succeeds (happy path: proving both directions)
    cleanup();
    renderRoute({
      path: `/prs/${owner}/${repo}/${known.pr_number}`,
      api: fourStateApi,
    });
    expect(await screen.findByText(new RegExp(`PR #${known.pr_number}`))).toBeInTheDocument();
  });

  it("a round missing input_tokens or cache_creation_input_tokens renders no cache percentage (finding 3943781313)", async () => {
    const [owner, repo] = baseRound.repository.split("/");
    const missingCacheTokens = [
      {
        ...baseRound,
        session_id: "pr-s-no-cache-input",
        pr_number: 401,
        pr_title: "PR with partial token telemetry",
        input_tokens: null,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
        recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "pr-s-no-cache-creation",
        pr_number: 402,
        pr_title: "PR with missing cache creation tokens",
        input_tokens: 1000,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: null,
        recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "pr-s-complete-cache",
        pr_number: 403,
        pr_title: "PR with complete token telemetry",
        input_tokens: 1000,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 500,
        recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
      },
    ];
    const cacheApi = makeFixtureApi(missingCacheTokens);

    // Missing input_tokens: no cache percentage
    renderRoute({ path: `/prs/${owner}/${repo}/401`, api: cacheApi });
    expect(await screen.findByTestId("round-timeline-card")).toBeInTheDocument();
    expect(screen.queryByText(/cache \d+%/)).toBeNull();

    // Missing cache_creation_input_tokens: no cache percentage
    cleanup();
    renderRoute({ path: `/prs/${owner}/${repo}/402`, api: cacheApi });
    expect(await screen.findByTestId("round-timeline-card")).toBeInTheDocument();
    expect(screen.queryByText(/cache \d+%/)).toBeNull();

    // Complete token telemetry: renders cache percentage (proving both directions)
    cleanup();
    renderRoute({ path: `/prs/${owner}/${repo}/403`, api: cacheApi });
    expect(await screen.findByTestId("round-timeline-card")).toBeInTheDocument();
    expect(screen.getByText(/cache 25\.0%/)).toBeInTheDocument();
  });

  it("ConfigInEffect renders unavailable limit and author-skip, and path match only on escalation (findings 3943781307, 3943781310)", async () => {
    const [owner, repo] = baseRound.repository.split("/");
    const configRounds = [
      {
        ...baseRound,
        session_id: "pr-cfg-default",
        pr_number: 501,
        pr_title: "PR with default model source",
        model_source: "default",
        recorded_at: new Date(now.getTime() - 2 * 3600000).toISOString(),
      },
      {
        ...baseRound,
        session_id: "pr-cfg-escalated",
        pr_number: 502,
        pr_title: "PR escalated by path match",
        model_source: "escalated by path match",
        recorded_at: new Date(now.getTime() - 1 * 3600000).toISOString(),
      },
    ];
    const configApi = makeFixtureApi(configRounds);

    // Default model source: no match, unavailable limit, unavailable skip author
    renderRoute({ path: `/prs/${owner}/${repo}/501`, api: configApi });
    const cardDefault = await screen.findByTestId("config-in-effect-card");
    expect(within(cardDefault).getByText("automatic-round limit unavailable")).toBeInTheDocument();
    expect(within(cardDefault).getByText("no match")).toBeInTheDocument();
    expect(within(cardDefault).getByText("unavailable")).toBeInTheDocument();

    // Escalated model source: path match is proven (both directions proven)
    cleanup();
    renderRoute({ path: `/prs/${owner}/${repo}/502`, api: configApi });
    const cardEscalated = await screen.findByTestId("config-in-effect-card");
    expect(within(cardEscalated).getByText("match")).toBeInTheDocument();
    expect(within(cardEscalated).getByText("unavailable")).toBeInTheDocument();
  });

  it("handles clipboard success and failure without unhandled rejections (finding 3943781302)", async () => {
    const amber = fourStateRounds[1]; // PR 202 (auto-paused, has unblock hint)
    const [owner, repo] = amber.repository.split("/");

    // Success path: writeText resolves
    const originalClipboard = navigator.clipboard;
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });

    renderRoute({
      path: `/prs/${owner}/${repo}/${amber.pr_number}`,
      api: fourStateApi,
    });

    const copyBtn = await screen.findByRole("button", { name: /copy/i });
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(writeTextMock).toHaveBeenCalledWith("@claude review");
    expect(screen.getByText("Copied")).toBeInTheDocument();

    // Failure path: writeText rejects (both directions proven)
    cleanup();
    const rejectingMock = vi.fn().mockRejectedValue(new Error("clipboard permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: rejectingMock },
      configurable: true,
      writable: true,
    });

    renderRoute({
      path: `/prs/${owner}/${repo}/${amber.pr_number}`,
      api: fourStateApi,
    });

    const failingCopyBtn = await screen.findByRole("button", { name: /copy/i });
    await act(async () => {
      fireEvent.click(failingCopyBtn);
    });
    expect(rejectingMock).toHaveBeenCalledWith("@claude review");
    expect(screen.queryByText("Copied")).toBeNull();

    // Restore original clipboard
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });
});



