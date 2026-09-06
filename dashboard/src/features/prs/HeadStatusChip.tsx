import type { HeadStatus } from "./headStatus";

function statusStyles(state: HeadStatus["state"]) {
  switch (state) {
    case "failed":
      return {
        bg: "bg-[var(--destructive-muted,#DB4A781f)]",
        border: "border-[var(--destructive,#DB4A7855)]",
        text: "text-[var(--destructive,#DB4A78)]",
        dotColor: "#DB4A78",
      };
    case "did-not-run":
      return {
        bg: "bg-[#AD87341f]",
        border: "border-[#AD873455]",
        text: "text-[var(--warning,#AD8734)]",
        dotColor: "#AD8734",
      };
    case "threads-only":
      return {
        bg: "bg-[#4E7FE01f]",
        border: "border-[#4E7FE055]",
        text: "text-[#4E7FE0]",
        dotColor: "#4E7FE0",
      };
    case "reviewed":
      return {
        bg: "bg-[#3AA3681f]",
        border: "border-[#3AA36855]",
        text: "text-[#3AA368]",
        dotColor: "#3AA368",
      };
  }
}

export function HeadStatusChip({ status }: { status: HeadStatus }) {
  const styles = statusStyles(status.state);

  return (
    <span
      data-testid="head-status-chip"
      data-state={status.state}
      title={status.rawVerdict ?? status.explain}
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium border ${styles.bg} ${styles.border} ${styles.text}`}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0">
        <circle cx="4" cy="4" r="3" fill={styles.dotColor} />
      </svg>
      {status.label}
    </span>
  );
}
