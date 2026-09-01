import { formatTimestamp } from "@/lib/format";

/** Displays in the viewer's zone; the exact UTC instant stays in `title` (#97). */
export function Timestamp({
  iso,
  className,
}: {
  iso: string | null | undefined;
  className?: string;
}) {
  return (
    <span className={className} title={iso ?? undefined}>
      {formatTimestamp(iso)}
    </span>
  );
}
