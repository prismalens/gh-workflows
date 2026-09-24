import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PrRow, RoundRow } from "@/api/types";
import { makeFixtureApi } from "@/fixtures/api";
import { makeRounds } from "@/fixtures/rounds";
import { renderRoute } from "@/test/renderRoute";

const now = new Date();
const base = makeRounds({ count: 1, now })[0];

function round(n: number, overrides: Partial<RoundRow>): RoundRow {
  return {
    ...base,
    session_id: `inbox-${n}`,
    pr_number: n,
    pr_title: `PR ${n}`,
    pr_author: "developer",
    pr_state: "open",
    repository: "acme/web",
    round_type: "full",
    verdict_kind: "reviewed",
    job_conclusion: "success",
    recorded_at: new Date(now.getTime() - n * 60_000).toISOString(),
    ...overrides,
  };
}

function prRow(r: RoundRow, overrides: Partial<PrRow>): PrRow {
  return {
    repository: r.repository,
    pr_number: r.pr_number!,
    state: "open",
    title: r.pr_title,
    author: r.pr_author,
    base_ref: null,
    head_ref: null,
    head_sha: r.head_sha,
    merged_at: null,
    closed_at: null,
    updated_at: r.recorded_at,
    source: "hook",
    total_findings: 0,
    open_findings: 0,
    ...overrides,
  };
}

const rounds = [
  round(1, { pr_title: "Retry webhook replay", verdict_kind: "silent", repository: "acme/payments" }),
  round(2, { pr_title: "Offline drafts", verdict_kind: "auto-paused", round_ordinal: 3 }),
  round(3, { pr_title: "Rotate signing keys", verdict_kind: "verify-rechecked", round_type: "verify" }),
  round(4, { pr_title: "Split ledger writer", pr_author: "aurora" }),
  round(5, { pr_title: "Clean one" }),
  round(6, { pr_title: "Clean two", repository: "acme/payments" }),
  round(7, { pr_title: "Closed and failed", verdict_kind: "silent" }),
];
const prs = [
  prRow(rounds[3], { total_findings: 3, open_findings: 2 }),
  prRow(rounds[6], { state: "closed", closed_at: now.toISOString() }),
];
const api = makeFixtureApi(rounds, [], [], [], prs);

function sectionTitles(section: HTMLElement): string[] {
  return within(section)
    .queryAllByRole("link")
    .map((a) => a.textContent ?? "");
}

describe("the nav (#185)", () => {
  it("has a Review group and an Operate group, and no longer lists PRs, Rounds or Failures", async () => {
    renderRoute({ path: "/", api });
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(nav.textContent).toBe("ReviewInboxFindingsReposOperateFleet");
    for (const gone of ["Overview", "PRs", "Rounds", "Failures"]) {
      expect(within(nav).queryByRole("link", { name: gone })).not.toBeInTheDocument();
    }
    expect(within(nav).getByRole("link", { name: "Fleet" }).getAttribute("href")).toMatch(/^\/fleet/);
  });
});

describe("/ inbox (#185)", () => {
  it("buckets open PRs into Failed, Did not run and Threads open, in that order", async () => {
    renderRoute({ path: "/", api });
    const failed = await screen.findByTestId("inbox-section-failed");
    const sections = screen.getAllByTestId(/^inbox-section-/);
    expect(sections.map((s) => s.dataset.testid)).toEqual([
      "inbox-section-failed",
      "inbox-section-did-not-run",
      "inbox-section-threads-open",
    ]);

    expect(sectionTitles(failed)).toEqual(["#1 Retry webhook replay"]);
    expect(sectionTitles(sections[1])).toEqual(["#2 Offline drafts"]);
    // A reviewed head with findings still open is not healthy.
    expect(sectionTitles(sections[2])).toEqual(["#3 Rotate signing keys", "#4 Split ledger writer"]);
    expect(screen.queryByText(/Closed and failed/)).not.toBeInTheDocument();
  });

  it("links each row to the PR detail page", async () => {
    renderRoute({ path: "/", api });
    const link = await screen.findByRole("link", { name: "#1 Retry webhook replay" });
    expect(link.getAttribute("href")).toBe("/prs/acme/payments/1");
  });

  it("hides healthy PRs behind a count until asked", async () => {
    renderRoute({ path: "/", api });
    const toggle = await screen.findByRole("button", { name: "2 healthy" });
    expect(screen.queryByText(/Clean one/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const healthy = screen.getByTestId("inbox-healthy");
    expect(sectionTitles(healthy)).toEqual(["#5 Clean one", "#6 Clean two"]);
  });

  it("filters every bucket by repository, title or author", async () => {
    renderRoute({ path: "/", api });
    const box = await screen.findByRole("searchbox", { name: "Search the inbox" });

    fireEvent.change(box, { target: { value: "acme/payments" } });
    expect(sectionTitles(screen.getByTestId("inbox-section-failed"))).toHaveLength(1);
    expect(sectionTitles(screen.getByTestId("inbox-section-threads-open"))).toHaveLength(0);
    expect(screen.getByRole("button", { name: "1 healthy" })).toBeInTheDocument();

    fireEvent.change(box, { target: { value: "AURORA" } });
    expect(sectionTitles(screen.getByTestId("inbox-section-threads-open"))).toEqual([
      "#4 Split ledger writer",
    ]);
    expect(sectionTitles(screen.getByTestId("inbox-section-failed"))).toHaveLength(0);

    fireEvent.change(box, { target: { value: "offline" } });
    expect(sectionTitles(screen.getByTestId("inbox-section-did-not-run"))).toEqual([
      "#2 Offline drafts",
    ]);
  });
});

describe("routes that left the nav still resolve (#185)", () => {
  it.each([
    ["/fleet", "Fleet"],
    ["/prs", "Pull requests"],
    ["/rounds", "Rounds"],
    ["/failures", "Failure surface"],
  ])("%s", async (path, heading) => {
    renderRoute({ path, api: makeFixtureApi(makeRounds({ count: 64, now })) });
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.queryByText("No such page")).not.toBeInTheDocument();
  });
});
