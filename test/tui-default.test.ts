import { describe, expect, it } from "vitest";
import { shouldUseTui } from "../src/tui/default.js";

describe("interactive frontend selection", () => {
  it("uses the TUI by default", () => {
    expect(shouldUseTui({}, {})).toBe(true);
  });

  it("allows classic mode through flag or environment", () => {
    expect(shouldUseTui({ classic: true }, {})).toBe(false);
    expect(shouldUseTui({}, { CLAI_CLASSIC: "1" })).toBe(false);
    expect(shouldUseTui({}, { CLAI_TUI: "0" })).toBe(false);
  });

  it("lets an explicit TUI flag override environment opt-out", () => {
    expect(shouldUseTui({ tui: true }, { CLAI_CLASSIC: "1" })).toBe(true);
  });
});
