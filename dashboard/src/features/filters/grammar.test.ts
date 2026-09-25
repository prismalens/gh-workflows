import { describe, expect, it } from "vitest";

import {
  matchesAge,
  parseAge,
  parseQuery,
  serializeQuery,
} from "./grammar";

describe("parseQuery", () => {
  it("splits tokens from free text", () => {
    const parsed = parseQuery("repo:assayer/web path:src/main.ts broken build");
    expect(parsed.tokens).toEqual([
      { key: "repo", value: "assayer/web" },
      { key: "path", value: "src/main.ts" },
    ]);
    expect(parsed.text).toBe("broken build");
  });

  it("leaves unknown keys as text", () => {
    const parsed = parseQuery("unknown:foo bar:baz hello");
    expect(parsed.tokens).toEqual([]);
    expect(parsed.text).toBe("unknown:foo bar:baz hello");
  });

  it("later token wins for the same key", () => {
    const parsed = parseQuery("repo:first repo:second");
    expect(parsed.tokens).toEqual([{ key: "repo", value: "second" }]);
    expect(parsed.text).toBe("");
  });

  it("normalizes the case of the key", () => {
    const parsed = parseQuery("REPO:acme/backend FATE:never-answered");
    expect(parsed.tokens).toEqual([
      { key: "repo", value: "acme/backend" },
      { key: "fate", value: "never-answered" },
    ]);
  });
});

describe("serializeQuery round-trip", () => {
  it("round-trips parsed tokens and text", () => {
    const initial = "repo:acme/web path:src/lib.ts failing test";
    const parsed = parseQuery(initial);
    const serialized = serializeQuery(parsed);
    expect(serializeQuery(parseQuery(serialized))).toBe(serialized);
    expect(parsed.tokens).toEqual([
      { key: "repo", value: "acme/web" },
      { key: "path", value: "src/lib.ts" },
    ]);
    expect(parsed.text).toBe("failing test");
  });
});

describe("parseAge", () => {
  it("parses >7d", () => {
    expect(parseAge(">7d")).toEqual({ op: ">", days: 7 });
  });

  it("parses <1d", () => {
    expect(parseAge("<1d")).toEqual({ op: "<", days: 1 });
  });

  it("parses >4w", () => {
    expect(parseAge(">4w")).toEqual({ op: ">", days: 28 });
  });

  it("parses 36h to 1.5 days", () => {
    expect(parseAge("36h")).toEqual({ op: ">", days: 1.5 });
  });

  it("parses bare number as days with > op", () => {
    expect(parseAge("3")).toEqual({ op: ">", days: 3 });
  });

  it("returns null for garbage", () => {
    expect(parseAge("garbage")).toBeNull();
    expect(parseAge("")).toBeNull();
    expect(parseAge(">")).toBeNull();
    expect(parseAge("foo7d")).toBeNull();
  });
});

describe("matchesAge", () => {
  it("evaluates > and < bounds correctly", () => {
    const gt7 = parseAge(">7d");
    expect(matchesAge(8, gt7)).toBe(true);
    expect(matchesAge(7, gt7)).toBe(false);
    expect(matchesAge(6, gt7)).toBe(false);

    const lt1 = parseAge("<1d");
    expect(matchesAge(0.5, lt1)).toBe(true);
    expect(matchesAge(1, lt1)).toBe(false);
    expect(matchesAge(2, lt1)).toBe(false);
  });

  it("returns true when bound is null", () => {
    expect(matchesAge(5, null)).toBe(true);
  });

  it("returns false when ageDays is null but bound exists", () => {
    expect(matchesAge(null, parseAge(">7d"))).toBe(false);
  });
});
