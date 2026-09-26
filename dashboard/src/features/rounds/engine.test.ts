import { describe, expect, it } from "vitest";

import { ACTIONS_LANE, distinctEngines, engineLabel } from "./engine";

describe("engine (#185)", () => {
  it("names a null engine as the Actions lane", () => {
    expect(engineLabel({ engine: null })).toBe(ACTIONS_LANE);
    expect(engineLabel({ engine: undefined })).toBe(ACTIONS_LANE);
    expect(engineLabel({ engine: "opencode" })).toBe("opencode");
  });

  it("lists each engine once, sorted", () => {
    expect(distinctEngines([{ engine: "opencode" }, { engine: null }, { engine: "opencode" }])).toEqual([
      ACTIONS_LANE,
      "opencode",
    ]);
  });
});
