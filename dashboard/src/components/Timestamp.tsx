import { formatTimestamp, formatTimestampCompact } from "@/lib/format";

/** Displays in the viewer's zone; the exact UTC instant stays in `title` (#97). */
export function Timestamp({
  iso,
  compact = false,
  className,
}: {
  iso: string | null | undefined;
  /** Table cells: `Aug 31 08:14`, the full form stays in `title`. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={className} title={compact ? formatTimestamp(iso) : (iso ?? undefined)}>
      {compact ? formatTimestampCompact(iso) : formatTimestamp(iso)}
    </span>
  );
}
