import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTimestamp, localDay } from "./format";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatTimestamp reads the viewer's zone (#97)", () => {
  it("converts the stored UTC instant into the viewer's zone", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    // 19:10Z is 00:40 the next day in IST. The browser picks the wording; this pins the instant.
    const rendered = formatTimestamp("2026-08-31T19:10:00.000Z");
    expect(rendered).toContain("2026");
    expect(rendered).toMatch(/12:40|00:40/);
  });

  it("lands the same instant on the previous day for a viewer behind UTC", () => {
    vi.stubEnv("TZ", "America/New_York");
    // The browser picks the clock, so a 24-hour locale renders this as 15:10 (#97).
    const rendered = formatTimestamp("2026-08-31T19:10:00.000Z");
    expect(rendered).toMatch(/(^|\D)(3:10|15:10)(\D|$)/);
    expect(rendered).toContain("31");
  });

  it("renders the same instant in UTC, proving the zone is read rather than hardcoded", () => {
    vi.stubEnv("TZ", "UTC");
    expect(formatTimestamp("2026-08-31T19:10:00.000Z")).toMatch(/7:10|19:10/);
  });

  it("still returns a dash for a missing timestamp regardless of zone", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
  });
});

describe("localDay follows the same zone as formatTimestamp (#97)", () => {
  it("puts a late UTC evening on the next IST calendar day", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(localDay("2026-08-31T19:10:00.000Z")).toBe("2026-09-01");
  });

  it("keeps the same instant on its own day under UTC", () => {
    vi.stubEnv("TZ", "UTC");
    expect(localDay("2026-08-31T19:10:00.000Z")).toBe("2026-08-31");
  });
});
