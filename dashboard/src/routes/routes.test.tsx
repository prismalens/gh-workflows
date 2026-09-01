import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

  it("renders the verdict mix in its two-state degraded form and says why", async () => {
    renderRoute({ path: "/", api: fullApi });
    const strip = await screen.findByTestId("verdict-strip");
    expect(within(strip).getByText("reviewed")).toBeInTheDocument();
    expect(within(strip).getByText("unknown")).toBeInTheDocument();
    for (const absent of ["threads-only", "did-not-run", "silent"]) {
      expect(within(strip).queryByText(absent)).not.toBeInTheDocument();
    }
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

  it("puts n on every tile it renders", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    const counts = await screen.findAllByTestId("tile-n");
    expect(counts).toHaveLength(5);
    for (const count of counts) {
      expect(count).toHaveTextContent(/^n = \d+$/);
    }
  });

  it("labels total_cost_usd as the list-rate equivalent and keeps it out of the tiles", async () => {
    renderRoute({ path: "/rounds", api: fullApi });
    const table = await screen.findByRole("table");
    expect(within(table).getByText(LIST_RATE_EQUIVALENT)).toBeInTheDocument();

    const tiles = screen.getByTestId("tile-strip");
    expect(tiles.textContent).not.toMatch(/\$/);
    expect(tiles.textContent).not.toMatch(/cost|usd/i);
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

  it("renders the round table instead of tiles when the range is thin", async () => {
    renderRoute({ path: "/rounds", api: sparseApi });
    expect(await screen.findByText(/the table below is the summary/)).toBeInTheDocument();
    expect(screen.queryByTestId("tile-n")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("says no rounds in range rather than showing zeros", async () => {
    renderRoute({ path: "/rounds", api: emptyApi });
    expect((await screen.findAllByText("No rounds in range")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
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
    expect(perAgent).toHaveAttribute("data-reason", "unbuilt");
  });

  it("separates a field the lane never sent from one that is not built yet", async () => {
    renderRoute({ path: detailPath(verify.session_id, verify.recorded_at), api });
    const degraded = await screen.findAllByTestId("degraded");
    const reasons = new Set(degraded.map((node) => node.getAttribute("data-reason")));
    expect(reasons).toContain("lane-did-not-send");
    expect(reasons).toContain("unbuilt");
    expect(
      degraded.some((node) => node.textContent?.includes("Subagent lifecycle counts")),
    ).toBe(true);
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

  const wallClockColumn = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[5]?.textContent?.trim() ?? "");

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
    const tokens = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[8]?.textContent?.trim() ?? "");
    expect(tokens.slice(-4)).toEqual(["—", "—", "—", "—"]);
    expect(tokens).not.toContain("0");
  });

  it("sorts a nulled list-rate equivalent last too", async () => {
    renderRoute({ path: "/rounds?sort=total_cost_usd&dir=asc", api });
    await screen.findByRole("table");
    const costs = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelectorAll("td")[9]?.textContent?.trim() ?? "");
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

describe("/compare route integration", () => {
  const sampleChanges = [
    {
      id: "c-sonnet-37",
      name: "Upgrade reviewer to Claude 3.7 Sonnet",
      at: "2026-08-15T12:00:00.000Z",
      source_url: "https://github.com/prismalens/gh-workflows/pull/73",
      scope: "fleet" as const,
      repository: null,
      created_at: "2026-08-15T12:05:00.000Z",
    },
  ];

  it("with no changes registered, the page says so and renders no tiles and no zeros", async () => {
    // API with rounds but 0 changes in registry
    const noChangesApi = makeFixtureApi(makeRounds({ count: 20, now }), [], []);
    renderRoute({ path: "/compare", api: noChangesApi });

    expect(
      await screen.findByText("No changes registered, therefore nothing to compare"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Register a change via curl/)).toBeInTheDocument();
    expect(screen.getByText(/curl -X POST/)).toBeInTheDocument();

    // Renders no tiles, no zeros, and no placeholder deltas
    expect(screen.queryByTestId("tile-strip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tile-n")).not.toBeInTheDocument();
    expect(screen.queryByTestId("metric-delta")).not.toBeInTheDocument();
    expect(screen.queryByText("0% change")).not.toBeInTheDocument();
  });

  it("with a change registered but no rounds on one side, that side says so in words", async () => {
    // All rounds recorded after change.at (so before window is empty)
    const afterOnlyRounds = Array.from({ length: 15 }, (_, i) => ({
      ...makeRounds({ count: 1 })[0],
      session_id: `after-${i}`,
      round_type: "review",
      recorded_at: `2026-08-2${i % 9}T00:00:00.000Z`,
      duration_ms: 5000,
    }));
    const afterOnlyApi = makeFixtureApi(afterOnlyRounds, [], sampleChanges);

    renderRoute({ path: "/compare", api: afterOnlyApi });

    expect(await screen.findByText("No rounds recorded before this change")).toBeInTheDocument();
    expect(screen.getByTestId("before-window-n")).toHaveTextContent("n = 0");
    expect(screen.getByTestId("after-window-n")).toHaveTextContent("n = 15");
    expect(screen.queryByText("0% change")).not.toBeInTheDocument();

    cleanup();

    // All rounds recorded before change.at (so after window is empty)
    const beforeOnlyRounds = Array.from({ length: 15 }, (_, i) => ({
      ...makeRounds({ count: 1 })[0],
      session_id: `before-${i}`,
      round_type: "review",
      recorded_at: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
      duration_ms: 5000,
    }));
    const beforeOnlyApi = makeFixtureApi(beforeOnlyRounds, [], sampleChanges);

    renderRoute({ path: "/compare", api: beforeOnlyApi });

    expect(await screen.findByText("No rounds recorded after this change")).toBeInTheDocument();
    expect(screen.getByTestId("before-window-n")).toHaveTextContent("n = 15");
    expect(screen.getByTestId("after-window-n")).toHaveTextContent("n = 0");
    expect(screen.queryByText("0% change")).not.toBeInTheDocument();
  });

  it("deltas are uncoloured when either side has n below 10, and coloured when both clear it", async () => {
    // Before: 5 rounds (low n < 10), After: 15 rounds (>= 10)
    const mixedRounds = [
      ...Array.from({ length: 5 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `b-${i}`,
        round_type: "review",
        recorded_at: `2026-08-0${i + 1}T00:00:00.000Z`,
        duration_ms: 6000,
        permission_denials: 0,
        input_tokens: 1000,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 500,
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `a-${i}`,
        round_type: "review",
        recorded_at: `2026-08-2${i % 9}T00:00:00.000Z`,
        duration_ms: 3000,
        permission_denials: 0,
        input_tokens: 1000,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      })),
    ];
    const lowNApi = makeFixtureApi(mixedRounds, [], sampleChanges);

    renderRoute({ path: "/compare", api: lowNApi });
    await screen.findByTestId("compare-page");

    // Low n badge is visible
    expect(screen.getAllByTestId("low-n-badge").length).toBeGreaterThan(0);
    // Delta element is uncoloured (font-normal, no emerald/destructive color class)
    const deltas = screen.getAllByTestId("metric-delta");
    expect(deltas[0].className).toContain("font-normal");
    expect(deltas[0].className).not.toContain("text-emerald");
    expect(deltas[0].className).not.toContain("text-destructive");

    cleanup();

    // High n: Before: 12 rounds (>= 10), After: 15 rounds (>= 10)
    const highNRounds = [
      ...Array.from({ length: 12 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `b-${i}`,
        round_type: "review",
        recorded_at: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
        duration_ms: 6000,
        permission_denials: 0,
        input_tokens: 1000,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 500,
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `a-${i}`,
        round_type: "review",
        recorded_at: `2026-08-2${i % 9}T00:00:00.000Z`,
        duration_ms: 3000,
        permission_denials: 0,
        input_tokens: 1000,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      })),
    ];
    const highNApi = makeFixtureApi(highNRounds, [], sampleChanges);

    renderRoute({ path: "/compare", api: highNApi });
    await screen.findByTestId("compare-page");

    // Low n badge is NOT present
    expect(screen.queryByTestId("low-n-badge")).not.toBeInTheDocument();
    // Delta elements have colored classes (emerald for improvement since duration dropped from 6s to 3s)
    const coloredDeltas = screen.getAllByTestId("metric-delta");
    expect(coloredDeltas[0].className).toContain("text-emerald");
  });

  it("a comparison needing p95 with either side under n=20 is refused, and the refusal names the short side and its n", async () => {
    // Before: 14 rounds (< 20), After: 22 rounds (>= 20)
    const p95UnderRounds = [
      ...Array.from({ length: 14 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `b-${i}`,
        round_type: "review",
        recorded_at: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
        duration_ms: 5000,
      })),
      ...Array.from({ length: 22 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `a-${i}`,
        round_type: "review",
        recorded_at: `2026-08-2${i % 9}T00:00:00.000Z`,
        duration_ms: 4000,
      })),
    ];
    const p95Api = makeFixtureApi(p95UnderRounds, [], sampleChanges);

    renderRoute({ path: "/compare", api: p95Api });
    await screen.findByTestId("compare-page");

    // Check refusal copy in the rendered card
    const refusal = await screen.findByTestId("refusal-reason");
    expect(refusal.textContent).toBe(
      "p95 comparison refused: before window has n = 14 (requires n ≥ 20)",
    );
  });

  it("round types are never pooled, and a type present on only one side is reported rather than compared", async () => {
    const splitTypeRounds = [
      ...Array.from({ length: 15 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `b-rev-${i}`,
        round_type: "review",
        recorded_at: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
        duration_ms: 6000,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `b-leg-${i}`,
        round_type: "legacy",
        recorded_at: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
        duration_ms: 9000,
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `a-rev-${i}`,
        round_type: "review",
        recorded_at: `2026-08-2${i % 9}T00:00:00.000Z`,
        duration_ms: 4000,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        ...makeRounds({ count: 1 })[0],
        session_id: `a-inc-${i}`,
        round_type: "incremental",
        recorded_at: `2026-08-2${i % 9}T00:00:00.000Z`,
        duration_ms: 2000,
      })),
    ];
    const splitApi = makeFixtureApi(splitTypeRounds, [], sampleChanges);

    renderRoute({ path: "/compare", api: splitApi });
    await screen.findByTestId("compare-page");

    // Sections for review, legacy, incremental exist separately
    expect(screen.getByTestId("round-type-section-review")).toBeInTheDocument();
    expect(screen.getByTestId("round-type-section-legacy")).toBeInTheDocument();
    expect(screen.getByTestId("round-type-section-incremental")).toBeInTheDocument();

    // Single-sided alerts report presence and absence in words
    const legacySection = screen.getByTestId("round-type-section-legacy");
    expect(
      within(legacySection).getByTestId("round-type-single-side-alert").textContent,
    ).toContain("Present before change (n = 5), absent after change (n = 0)");

    const incSection = screen.getByTestId("round-type-section-incremental");
    expect(
      within(incSection).getByTestId("round-type-single-side-alert").textContent,
    ).toContain("Present after change (n = 10), absent before change (n = 0)");

    // No pooled "All round types" section exists
    expect(screen.queryByTestId("round-type-section-all")).not.toBeInTheDocument();
  });

  it("the page has no date input anywhere", async () => {
    const api = makeFixtureApi(makeRounds({ count: 30, now }), [], sampleChanges);
    const { container } = renderRoute({ path: "/compare", api });
    await screen.findByTestId("compare-page");

    expect(container.querySelector('input[type="date"]')).toBeNull();
    const inputs = container.querySelectorAll("input");
    for (const input of inputs) {
      expect(input.getAttribute("type")).not.toBe("date");
    }
  });

  it("refuses the comparison rather than compute it from a truncated page (#104 finding 2)", async () => {
    const base = makeFixtureApi(makeRounds({ count: 30, now }), [], sampleChanges);
    const truncatedApi = {
      ...base,
      fetchRuns: async (query: Parameters<typeof base.fetchRuns>[0]) => {
        const page = await base.fetchRuns(query);
        return { ...page, next_cursor: "2026-08-01T00:00:00.000Z|fake" };
      },
    };

    renderRoute({ path: "/compare", api: truncatedApi });

    expect(await screen.findByText("Comparison refused")).toBeInTheDocument();
    expect(screen.getByTestId("compare-truncated-refusal")).toHaveTextContent(
      /more than 1000 rounds/,
    );
    expect(screen.queryByTestId("metric-delta")).not.toBeInTheDocument();
    expect(screen.queryByText("0% change")).not.toBeInTheDocument();
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


