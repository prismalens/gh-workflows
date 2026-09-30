import { describe, expect, it } from "vitest";

import { CONFIG_FIELDS, changedKeys, parseYamlValue, readValue, validateConfigText, writeValue } from "./configEdit";

const FILE = "# kept\nversion: 1\nreview:\n  level: medium # also kept\n";

describe("configEdit (#78)", () => {
  it("lists every schema key, with the config_effective key the lane records", () => {
    const paths = CONFIG_FIELDS.map((f) => f.path.join("."));
    expect(paths[0]).toBe("extends");
    expect(paths).toContain("review.level");
    expect(paths).toContain("findings.suppress_below");
    expect(CONFIG_FIELDS.find((f) => f.path.join(".") === "telemetry.share")?.effectiveKey).toBe("telemetry_share");
    expect(CONFIG_FIELDS.find((f) => f.path.join(".") === "review.context")?.kind).toBe("yaml");
    expect(CONFIG_FIELDS.find((f) => f.path.join(".") === "review.tool_findings")?.kind).toBe("list");
  });

  it("changes one key and keeps every comment", () => {
    const next = writeValue(FILE, ["review", "level"], "high");
    expect(next).toBe("# kept\nversion: 1\nreview:\n  level: high # also kept\n");
  });

  it("quotes a string off, since the lane's PyYAML would read a bare off as false", () => {
    const next = writeValue(FILE, ["telemetry", "share"], "off");
    expect(next).toContain('share: "off"');
    expect(next).not.toContain("!!omap");
    expect(readValue(next, ["telemetry", "share"])).toBe("off");
  });

  it("removing a section's last key removes the section, and an empty file gains version: 1", () => {
    const set = writeValue(FILE, ["findings", "suppress_below"], "Major");
    expect(writeValue(set, ["findings", "suppress_below"], undefined)).toBe(FILE);
    expect(writeValue("", ["review", "level"], "high")).toBe("version: 1\nreview:\n  level: high\n");
  });

  it("validates the way the lane does, naming the key", () => {
    expect(validateConfigText(FILE)).toEqual([]);
    expect(validateConfigText("version: 1\nreview:\n  level: low\n")).toEqual([
      'review/level: Instance does not match any of ["medium","high"].',
    ]);
    expect(validateConfigText("version: 1\nreview: [\n").length).toBeGreaterThan(0);
  });

  it("summarises the changed keys for the PR body", () => {
    const next = writeValue(writeValue(FILE, ["review", "level"], "high"), ["review", "skip_authors"], ["bot"]);
    expect(changedKeys(FILE, next)).toEqual(["review.level: medium → high", 'review.skip_authors: (not set) → ["bot"]']);
  });
});

describe("parseYamlValue (#237 review)", () => {
  it("parses a value and refuses text that is not YAML", () => {
    expect(parseYamlValue("- path: a/**\n  instructions: x")).toEqual({ ok: true, value: [{ path: "a/**", instructions: "x" }] });
    expect(parseYamlValue("[unclosed").ok).toBe(false);
  });
});
