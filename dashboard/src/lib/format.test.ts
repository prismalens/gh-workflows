import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTimestamp, localDay } from "./format";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatTimestamp reads the viewer's zone (#97)", () => {
  it("converts the stored UTC instant into the viewer's zone", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    // The browser picks locale, digits and padding, so asserting on those tests the locale
    // rather than the conversion. Pin the instant instead: same locale, explicit zone (#97).
    const iso = "2026-08-31T19:10:00.000Z";
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }).format(new Date(iso));
    expect(formatTimestamp(iso)).toBe(expected);
  });

  it("lands the same instant on the previous day for a viewer behind UTC", () => {
    vi.stubEnv("TZ", "America/New_York");
    const iso = "2026-08-31T19:10:00.000Z";
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/New_York",
    }).format(new Date(iso));
    expect(formatTimestamp(iso)).toBe(expected);
  });

  it("renders the same instant in UTC, proving the zone is read rather than hardcoded", () => {
    vi.stubEnv("TZ", "UTC");
    const iso = "2026-08-31T19:10:00.000Z";
    expect(formatTimestamp(iso)).toBe(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(iso)),
    );
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
