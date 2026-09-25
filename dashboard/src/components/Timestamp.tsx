import { formatRelative, formatTimestamp } from "@/lib/format";

/**
 * Displays in the viewer's zone; the exact UTC instant stays in `title` (#97).
 * `compact` reads relative under a week and as `Aug 31 08:14` beyond (#209).
 */
export function Timestamp({
  iso,
  compact = false,
  className,
}: {
  iso: string | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={className} title={compact ? formatTimestamp(iso) : (iso ?? undefined)}>
      {compact ? formatRelative(iso) : formatTimestamp(iso)}
    </span>
  );
}
