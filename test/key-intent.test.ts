import { describe, expect, it } from "vitest";
import { isComposerNewline, newlineHint } from "../src/tui/key-intent.js";

// The key shapes below mirror exactly what Ink's parseKeypress produces for
// each physical key (verified against ink/build/parse-keypress.js):
//   Enter        -> ch "\r", key.return true
//   Ctrl+J       -> ch "\n", no modifiers, key.return false
//   Alt+Enter    -> ch "\r", no modifiers, key.return false (ESC stripped)
//   Shift+Enter* -> key.return true + key.shift (only in protocol terminals)
describe("isComposerNewline — cross-OS newline detection", () => {
  it("plain Enter submits (never a newline)", () => {
    expect(isComposerNewline("\r", { return: true })).toBe(false);
  });

  it("Ctrl+J inserts a newline on every OS", () => {
    expect(
      isComposerNewline("\n", { return: false, ctrl: false, meta: false }),
    ).toBe(true);
  });

  it("Alt/Option+Enter (bare CR without Return flag) inserts a newline", () => {
    expect(
      isComposerNewline("\r", { return: false, ctrl: false, meta: false }),
    ).toBe(true);
  });

  it("Shift+Enter and Meta+Enter insert a newline when reported", () => {
    expect(isComposerNewline("", { return: true, shift: true })).toBe(true);
    expect(isComposerNewline("", { return: true, meta: true })).toBe(true);
  });

  it("does not treat other control chords as newline", () => {
    // Ctrl+A etc. — a control letter, not a line feed.
    expect(isComposerNewline("a", { ctrl: true })).toBe(false);
    // Meta+something without Return.
    expect(isComposerNewline("x", { meta: true })).toBe(false);
    // Ordinary character.
    expect(isComposerNewline("h", {})).toBe(false);
  });
});

describe("newlineHint — OS-specific instruction", () => {
  it("uses mac symbols on darwin and always mentions the universal Ctrl+J", () => {
    const mac = newlineHint("darwin");
    expect(mac).toContain("⌃J");
    expect(mac.toLowerCase()).toContain("newline");
  });

  it("uses ctrl+j wording on Windows and Linux", () => {
    expect(newlineHint("win32")).toContain("ctrl+j");
    expect(newlineHint("linux")).toContain("ctrl+j");
  });
});
