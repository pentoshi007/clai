import { describe, it, expect } from "vitest";
import { evaluateTui, MIN_COLS, MIN_ROWS } from "../../../src/ui-core/bootstrap/can-use-tui.js";

describe("evaluateTui gating", () => {
  it("requires both stdio ends to be TTYs", () => {
    expect(evaluateTui({ stdoutIsTTY: false, stdinIsTTY: true, columns: 100, rows: 40 }).ok).toBe(false);
    expect(evaluateTui({ stdoutIsTTY: true, stdinIsTTY: false, columns: 100, rows: 40 }).ok).toBe(false);
  });

  it("requires a minimum window size", () => {
    const small = evaluateTui({
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: MIN_COLS - 1,
      rows: MIN_ROWS,
    });
    expect(small.ok).toBe(false);
    expect(small.reason).toContain("too small");
  });

  it("accepts a real interactive terminal", () => {
    expect(
      evaluateTui({ stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }).ok,
    ).toBe(true);
  });
});
