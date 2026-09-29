import type { IngestAuthCounts, OpsIdentityRow } from "@/api/types";
import { formatCount } from "@/lib/format";

const AUTH_ORDER = ["oidc", "runner", "bearer", "unrecorded"];
const AUTH_LABEL: Record<string, string> = {
  oidc: "OIDC",
  runner: "runner",
  bearer: "bearer",
  unrecorded: "unrecorded",
};

/** "OIDC 31 · bearer 2", known values first, zero counts left out. */
export function describeAuthCounts(counts: IngestAuthCounts | undefined): string {
  if (!counts) return "—";
  const keys = Object.keys(counts)
    .filter((k) => counts[k] > 0)
    .sort((a, b) => {
      const ia = AUTH_ORDER.indexOf(a);
      const ib = AUTH_ORDER.indexOf(b);
      return (ia === -1 ? AUTH_ORDER.length : ia) - (ib === -1 ? AUTH_ORDER.length : ib) || a.localeCompare(b);
    });
  if (keys.length === 0) return "—";
  return keys.map((k) => `${AUTH_LABEL[k] ?? k} ${formatCount(counts[k])}`).join(" · ");
}

export type IdentityStatus = "shared-token" | "predates-identity" | "bearer-free";

/** Any bearer row outranks an unrecorded one: the shared token is what #176 retires. */
export function identityStatus(row: OpsIdentityRow): IdentityStatus {
  const tables = Object.values(row.tables);
  if (tables.some((c) => (c?.bearer ?? 0) > 0)) return "shared-token";
  if (tables.some((c) => (c?.unrecorded ?? 0) > 0)) return "predates-identity";
  return "bearer-free";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
