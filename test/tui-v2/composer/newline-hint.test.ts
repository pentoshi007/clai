import { describe, expect, it } from "vitest";
import { resolveNewlineHint } from "../../../src/tui-v2/composer/newline-hint.js";

describe("resolveNewlineHint", () => {
  it("advertises Shift+Enter when the terminal can distinguish it", () => {
    const hint = resolveNewlineHint({ canDistinguishShiftEnter: true });
    expect(hint.chord).toBe("shift+enter");
  });

  it("falls back to Alt/Option+Enter otherwise", () => {
    const hint = resolveNewlineHint({ canDistinguishShiftEnter: false });
    expect(hint.chord).toBe("alt+enter");
  });
});
