import { describe, expect, it } from "vitest";

import { describeAuthCounts, formatBytes, identityStatus } from "./ops";

describe("ops", () => {
  it("lists known ingest identities first and drops zero counts", () => {
    expect(describeAuthCounts({ unrecorded: 3, bearer: 0, oidc: 31, zeta: 1 })).toBe(
      "OIDC 31 · unrecorded 3 · zeta 1",
    );
    expect(describeAuthCounts(undefined)).toBe("—");
    expect(describeAuthCounts({ oidc: 0 })).toBe("—");
  });

  it("ranks a bearer row over an unrecorded one", () => {
    expect(
      identityStatus({ repository: "o/a", tables: { usage_records: { oidc: 1, unrecorded: 2 }, prs: { bearer: 1 } } }),
    ).toBe("shared-token");
    expect(identityStatus({ repository: "o/a", tables: { lane_events: { unrecorded: 1 } } })).toBe(
      "predates-identity",
    );
    expect(identityStatus({ repository: "o/a", tables: { usage_records: { oidc: 4, runner: 1 } } })).toBe(
      "bearer-free",
    );
  });

  it("formats D1 sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2072576)).toBe("2.0 MB");
    expect(formatBytes(412 * 1024 * 1024)).toBe("412 MB");
  });
});
