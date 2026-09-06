import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import { formatTimestamp } from "@/lib/format";
import { groupRoundsByPR, type PRSummary } from "./prs";
import { PRsTable, type PRsTableProps } from "./PRsTable";

const BASE = makeRounds({ count: 1 })[0];

function pr(overrides: Partial<RoundRow> & { pr_number: number }): PRSummary {
  const round: RoundRow = { ...BASE, ...overrides };
  return groupRoundsByPR([round])[0];
}

/** PRsTable links to the PR-detail route, so it needs a router in scope. The
 * match resolves asynchronously even for a synchronous root component. */
async function renderTable(props: PRsTableProps) {
  const rootRoute = createRootRoute({ component: () => <PRsTable {...props} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  return screen.findByRole("table");
}

function bodyRows(table: HTMLElement): HTMLElement[] {
  return Array.from(table.querySelectorAll("tbody tr"));
}

describe("PRsTable compact timestamps (#141)", () => {
  it("shows the compact form for the last round and carries the full form in the title", async () => {
    const iso = "2026-08-31T08:14:00.000Z";
    await renderTable({
      prs: [pr({ pr_number: 1, session_id: "p1", recorded_at: iso })],
      sorting: [],
      onSortingChange: vi.fn(),
    });
    const cell = screen.getByText(/^\w{3} \d{1,2} \d{2}:\d{2}$/);
    expect(cell).toHaveAttribute("title", formatTimestamp(iso));
  });
});

describe("PRsTable pagination (#141)", () => {
  const fivePrs = Array.from({ length: 5 }, (_, i) =>
    pr({ pr_number: 100 + i, session_id: `p-${i}`, job_conclusion: "success", verdict_kind: "clean" }),
  );

  it("renders every row on one page when pagination is not controlled", async () => {
    const table = await renderTable({ prs: fivePrs, sorting: [], onSortingChange: vi.fn() });
    expect(bodyRows(table)).toHaveLength(5);
  });

  it("slices to the controlled page and size", async () => {
    const table = await renderTable({
      prs: fivePrs,
      sorting: [],
      onSortingChange: vi.fn(),
      pagination: { pageIndex: 1, pageSize: 2 },
    });
    expect(bodyRows(table)).toHaveLength(2);
  });
});
