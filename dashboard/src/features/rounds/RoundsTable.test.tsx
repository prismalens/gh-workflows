import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RoundRow } from "@/api/types";
import { makeRounds } from "@/fixtures/rounds";
import { formatDuration, formatTimestamp } from "@/lib/format";
import { RoundsTable, type RoundsTableProps } from "./RoundsTable";

const BASE = makeRounds({ count: 1 })[0];

function row(overrides: Partial<RoundRow>): RoundRow {
  return { ...BASE, ...overrides };
}

/**
 * RoundsTable links to the round-detail route, so it needs a router in scope.
 * The router resolves its match asynchronously even for a synchronous root
 * component, so every test awaits the table before reading its rows.
 */
async function renderTable(props: RoundsTableProps) {
  const rootRoute = createRootRoute({ component: () => <RoundsTable {...props} /> });
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

describe("RoundsTable verdict column (#141)", () => {
  it("renders a dash with a predates-the-field title when verdict_kind is null", async () => {
    await renderTable({
      rows: [row({ session_id: "s1", verdict_kind: null })],
      sorting: [],
      onSortingChange: vi.fn(),
    });
    const dash = screen.getByText("—", { selector: "span[title]" });
    expect(dash).toHaveAttribute("title", "This round predates the verdict fields.");
    expect(screen.queryByTestId("head-status-chip")).not.toBeInTheDocument();
  });

  it("reuses headStatus's decode so the label matches the PR page's", async () => {
    await renderTable({
      rows: [row({ session_id: "s2", verdict_kind: "clean", job_conclusion: "success" })],
      sorting: [],
      onSortingChange: vi.fn(),
    });
    const chip = screen.getByTestId("head-status-chip");
    expect(chip).toHaveAttribute("data-state", "reviewed");
    expect(within(chip).getByText("reviewed")).toBeInTheDocument();
  });
});

describe("RoundsTable model column (#141)", () => {
  it("renders the raw model string, monospace, and a dash when absent", async () => {
    await renderTable({
      rows: [
        row({ session_id: "s3", model: "claude-opus-4-6" }),
        row({ session_id: "s4", model: null }),
      ],
      sorting: [],
      onSortingChange: vi.fn(),
    });
    const modelCell = screen.getByText("claude-opus-4-6");
    expect(modelCell.className).toMatch(/font-mono/);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("RoundsTable compact timestamps (#141)", () => {
  it("shows the compact form and carries the full form in the title", async () => {
    const iso = "2026-08-31T08:14:00.000Z";
    await renderTable({
      rows: [row({ session_id: "s5", recorded_at: iso })],
      sorting: [],
      onSortingChange: vi.fn(),
    });
    const link = screen.getByRole("link", { name: /^\w{3} \d{1,2} \d{2}:\d{2}$/ });
    expect(link).toHaveAttribute("title", formatTimestamp(iso));
  });
});

describe("RoundsTable pagination (#141)", () => {
  const fiveRows = Array.from({ length: 5 }, (_, i) =>
    row({ session_id: `page-${i}`, duration_ms: (5 - i) * 1000 }),
  );

  it("renders every row on one page when pagination is not controlled", async () => {
    const table = await renderTable({ rows: fiveRows, sorting: [], onSortingChange: vi.fn() });
    expect(bodyRows(table)).toHaveLength(5);
  });

  it("slices to the controlled page and size", async () => {
    const table = await renderTable({
      rows: fiveRows,
      sorting: [],
      onSortingChange: vi.fn(),
      pagination: { pageIndex: 1, pageSize: 2 },
    });
    expect(bodyRows(table)).toHaveLength(2);
  });

  it("sorts the whole set before slicing to the page, not the other way round", async () => {
    // Ascending by duration_ms: page-4..page-0 hold 1000..5000ms in that order.
    // Page index 1 of size 2 is the middle two (3000, 4000), which only lines up
    // if the sort ran over all five rows before the page was sliced out.
    const table = await renderTable({
      rows: fiveRows,
      sorting: [{ id: "duration_ms", desc: false }],
      onSortingChange: vi.fn(),
      pagination: { pageIndex: 1, pageSize: 2 },
    });
    const cells = bodyRows(table).map((r) => r.querySelectorAll("td")[7]?.textContent?.trim());
    expect(cells).toEqual([formatDuration(3000), formatDuration(4000)]);
  });
});

describe("RoundsTable footer (#141)", () => {
  const rows = [
    row({ session_id: "f1", duration_ms: 1000, permission_denials: 1 }),
    row({ session_id: "f2", duration_ms: 3000, permission_denials: 0 }),
    row({ session_id: "f3", duration_ms: 5000, permission_denials: 2 }),
  ];

  it("is absent unless showFooter is set", async () => {
    await renderTable({ rows, sorting: [], onSortingChange: vi.fn() });
    expect(screen.queryByTestId("rounds-footer-n")).not.toBeInTheDocument();
  });

  it("totals n, mean and max wall clock, and denials over every row handed in, not the visible page", async () => {
    const table = await renderTable({
      rows,
      sorting: [],
      onSortingChange: vi.fn(),
      pagination: { pageIndex: 0, pageSize: 1 },
      showFooter: true,
    });
    // Only one row is on the visible page...
    expect(bodyRows(table)).toHaveLength(1);
    // ...but the footer still totals across all three.
    const footerRow = screen.getByTestId("rounds-footer-n").closest("tr")!;
    expect(footerRow).toHaveTextContent("n = 3");
    expect(footerRow).toHaveTextContent(`mean wall clock ${formatDuration(3000)}`);
    expect(footerRow).toHaveTextContent(`max wall clock ${formatDuration(5000)}`);
    expect(footerRow).toHaveTextContent("total denials 3");
  });

  it("never mentions money", async () => {
    await renderTable({ rows, sorting: [], onSortingChange: vi.fn(), showFooter: true });
    const footerRow = screen.getByTestId("rounds-footer-n").closest("tr")!;
    expect(footerRow.textContent).not.toMatch(/\$/);
    expect(footerRow.textContent).not.toMatch(/cost|usd/i);
  });
});
