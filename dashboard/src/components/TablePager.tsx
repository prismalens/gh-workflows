import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

export interface TablePagerProps {
  /** 1-based, already clamped to [1, pageCount]. */
  page: number;
  pageCount: number;
  pageSize: PageSize;
  /** Rows in the set page/pageCount are computed over (after every filter). */
  total: number;
  /** Rows before search and the chip filters this lane adds. Omit when equal to total. */
  windowTotal?: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
}

/**
 * Previous/Next, the page-size choice, and the count line, shared by both
 * tables so the two pages read the same way (#141).
 */
export function TablePager({
  page,
  pageCount,
  pageSize,
  total,
  windowTotal,
  onPageChange,
  onPageSizeChange,
}: TablePagerProps) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const countLine =
    windowTotal !== undefined && windowTotal !== total
      ? `rows ${formatCount(start)} to ${formatCount(end)} of ${formatCount(total)} matching, ${formatCount(windowTotal)} in window`
      : `rows ${formatCount(start)} to ${formatCount(end)} of ${formatCount(total)}`;

  const showNav = pageCount > 1;

  return (
    <div className="flex flex-wrap items-center justify-end gap-3 text-xs">
      {showNav && (
        <>
          <button
            type="button"
            className="font-medium text-foreground/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="font-medium text-foreground/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </>
      )}
      <div role="group" aria-label="Rows per page" className="flex items-center gap-1">
        {PAGE_SIZE_OPTIONS.map((size) => (
          <Button
            key={size}
            type="button"
            size="sm"
            variant={size === pageSize ? "secondary" : "ghost"}
            aria-pressed={size === pageSize}
            onClick={() => onPageSizeChange(size)}
          >
            {size}
          </Button>
        ))}
      </div>
      <span className="text-muted-foreground">{countLine}</span>
    </div>
  );
}
