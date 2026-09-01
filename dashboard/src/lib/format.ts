export type Formatter = (value: number) => string;

export const formatDuration: Formatter = (ms) => {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  // Round to whole seconds first, or 479.7s renders as "7m 60s".
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
};

export const formatCount: Formatter = (n) =>
  Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2);

export const formatTokens: Formatter = (n) => {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
};

export const formatPercent: Formatter = (ratio) => `${(ratio * 100).toFixed(1)}%`;

export const formatMultiplier: Formatter = (m) => `${m.toFixed(2)}x`;

export const formatUsd: Formatter = (usd) =>
  usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;

const TIMESTAMP_PARTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
};

/**
 * No explicit `timeZone`, so this reads the viewer's runtime zone and names it
 * (#97). The exact UTC instant still belongs on the rendered element, via
 * `Timestamp`'s `title`, not here.
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", TIMESTAMP_PARTS).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/** The viewer's short zone name alone, e.g. for a chart axis label (#97). */
export function localZoneName(date: Date = new Date()): string {
  const part = new Intl.DateTimeFormat("en-CA", { timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

/** The viewer's calendar day for an ISO instant, YYYY-MM-DD in the local zone (#97). */
export function localDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function orDash(value: number | string | null | undefined, fmt?: Formatter): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return fmt ? fmt(value) : formatCount(value);
  return value;
}
