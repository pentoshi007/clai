import { describe, expect, it } from "vitest";
import { resolveNewlineHint } from "../../../src/tui-v2/composer/newline-hint.js";

describe("resolveNewlineHint", () => {
  it("always advertises Shift+Enter (primary on every OS)", () => {
    expect(resolveNewlineHint({ canDistinguishShiftEnter: true }).chord).toBe(
      "shift+enter",
    );
    expect(resolveNewlineHint({ canDistinguishShiftEnter: false }).chord).toBe(
      "shift+enter",
    );
    expect(resolveNewlineHint({ canDistinguishShiftEnter: true }).label).toMatch(
      /Shift\+Enter/i,
    );
  });
});
