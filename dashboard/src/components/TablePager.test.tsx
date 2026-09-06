import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TablePager } from "./TablePager";

describe("TablePager (#141)", () => {
  it("renders the plain count line and hides nav when everything fits on one page", () => {
    render(
      <TablePager
        page={1}
        pageCount={1}
        pageSize={25}
        total={12}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />,
    );
    expect(screen.getByText("rows 1 to 12 of 12")).toBeInTheDocument();
    expect(screen.queryByText("Previous")).not.toBeInTheDocument();
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
    // The size choice stays available even on a single page.
    expect(screen.getByRole("group", { name: "Rows per page" })).toBeInTheDocument();
  });

  it("shows Previous and Next, disabled at the edges, across more than one page", () => {
    render(
      <TablePager
        page={1}
        pageCount={2}
        pageSize={25}
        total={30}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />,
    );
    expect(screen.getByText("rows 1 to 25 of 30")).toBeInTheDocument();
    expect(screen.getByText("Previous")).toBeDisabled();
    expect(screen.getByText("Next")).not.toBeDisabled();
  });

  it("renders the matching-versus-window line only when the two counts differ", () => {
    const { rerender } = render(
      <TablePager
        page={1}
        pageCount={1}
        pageSize={25}
        total={12}
        windowTotal={132}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />,
    );
    expect(screen.getByText("rows 1 to 12 of 12 matching, 132 in window")).toBeInTheDocument();

    rerender(
      <TablePager
        page={1}
        pageCount={6}
        pageSize={25}
        total={132}
        windowTotal={132}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />,
    );
    expect(screen.getByText("rows 1 to 25 of 132")).toBeInTheDocument();
  });

  it("calls onPageChange with the adjacent page number", () => {
    const onPageChange = vi.fn();
    render(
      <TablePager
        page={2}
        pageCount={3}
        pageSize={25}
        total={60}
        onPageChange={onPageChange}
        onPageSizeChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Next"));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByText("Previous"));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("calls onPageSizeChange with the clicked size", () => {
    const onPageSizeChange = vi.fn();
    render(
      <TablePager
        page={1}
        pageCount={1}
        pageSize={25}
        total={12}
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    fireEvent.click(screen.getByText("50"));
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });
});
