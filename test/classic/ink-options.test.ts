import { describe, expect, it } from "vitest";
import { CLASSIC_INK_OPTIONS } from "../../src/classic/bootstrap/start-classic.js";

describe("classic ink render options", () => {
  it("repaints only changed rows so idle chrome animation never redraws the screen", () => {
    expect(CLASSIC_INK_OPTIONS.incrementalRendering).toBe(true);
  });

  it("leaves terminal ownership and Ctrl+C handling to the classic session", () => {
    expect(CLASSIC_INK_OPTIONS.exitOnCtrlC).toBe(false);
    expect(CLASSIC_INK_OPTIONS.patchConsole).toBe(false);
    expect(CLASSIC_INK_OPTIONS.alternateScreen).toBe(false);
  });
});
