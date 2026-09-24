import { describe, expect, it } from "vitest";

import { findingBodyText, parseFindingLabel } from "./severity";

describe("parseFindingLabel", () => {
  it("parses category and severity from formatted markdown label line", () => {
    const text = "_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_\n\n<details>summary</details>";
    const label = parseFindingLabel({ header_raw: text, body_excerpt: null });
    expect(label).toEqual({
      category: "Functional Correctness",
      severity: "major",
    });
  });

  it("prefers header_raw over body_excerpt", () => {
    const header = "_🎯 Security_ | _🔴 Critical_";
    const body = "_🎯 Functional Correctness_ | _🟠 Major_\n\nSome body";
    const label = parseFindingLabel({ header_raw: header, body_excerpt: body });
    expect(label).toEqual({
      category: "Security",
      severity: "critical",
    });
  });

  it("returns nulls for a body with no pipe (|)", () => {
    const label = parseFindingLabel({
      header_raw: null,
      body_excerpt: "Just a regular finding with no pipe character.",
    });
    expect(label).toEqual({
      category: null,
      severity: null,
    });
  });
});

describe("findingBodyText", () => {
  it("drops the label line and a <details> block", () => {
    const text =
      "_🎯 Functional Correctness_ | _🟠 Major_\n\nHere is the actual bug description.\n\n<details>more info</details>";
    const result = findingBodyText({ header_raw: null, body_excerpt: text });
    expect(result).toBe("Here is the actual bug description.");
  });

  it("falls back to the details text when nothing else remains", () => {
    const text = "<details>\nEvidence text in details\n</details>";
    const result = findingBodyText({ header_raw: null, body_excerpt: text });
    expect(result).toBe("Evidence text in details");
  });

  it("returns null for null body", () => {
    const result = findingBodyText({ header_raw: "Some header", body_excerpt: null });
    expect(result).toBeNull();
  });
});
