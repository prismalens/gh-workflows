import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTimestamp, localDay } from "./format";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatTimestamp reads the viewer's zone (#97)", () => {
  it("renders IST, 5:30 ahead of the stored UTC instant, and names the zone", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    const rendered = formatTimestamp("2026-08-31T19:10:00.000Z");
    // The zone abbreviation ("IST" vs "GMT+5:30") depends on the runner's ICU data, not on
    // this code, so only the wall-clock/offset and the presence of a label are asserted (#97).
    const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) (.+)$/.exec(rendered);
    expect(match?.[1]).toBe("2026-09-01 00:40");
    expect(match?.[2]).toBeTruthy();
  });

  it("renders the same instant in UTC, proving the zone is read rather than hardcoded", () => {
    vi.stubEnv("TZ", "UTC");
    expect(formatTimestamp("2026-08-31T19:10:00.000Z")).toBe("2026-08-31 19:10 UTC");
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
