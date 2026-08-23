import { describe, expect, it } from "vitest";
import {
  sanitizeDisplayText,
  stripAnsiSequences,
  stripControlChars,
} from "../../../src/ui-core/rendering/sanitize-display.js";

describe("sanitizeDisplayText", () => {
  it("strips CSI color sequences", () => {
    expect(stripAnsiSequences("\x1b[31mred\x1b[0m")).toBe("red");
    // SGR mouse reports must not leak into chat/report text.
    expect(stripAnsiSequences("hello\x1b[<35;67;37Mworld")).toBe("helloworld");
  });

  it("strips OSC title sequences", () => {
    expect(stripAnsiSequences("hi\x1b]0;title\x07there")).toBe("hithere");
  });

  it("keeps tab and newline", () => {
    expect(sanitizeDisplayText("a\tb\nc")).toBe("a\tb\nc");
  });

  it("drops null, ESC, and DEL", () => {
    expect(stripControlChars("a\x00b\x1bc\x7fd")).toBe("abcd");
  });

  it("removes orphan escapes from malformed ANSI output", () => {
    const dirty = "\x1b\x1bError\x1b: Test timed out in 5000ms.";
    const clean = sanitizeDisplayText(dirty);
    expect(clean).toBe("rror: Test timed out in 5000ms.");
    expect(clean).not.toContain("\x1b");
  });

  it("neutralizes incomplete and chunk-split escape sequences", () => {
    expect(sanitizeDisplayText("\x1b[31")).toBe("[31");
    expect(sanitizeDisplayText("\x1b") + sanitizeDisplayText("[31mred")).toBe(
      "[31mred",
    );
  });

  it("drops cursor controls, BEL, carriage return, backspace, and C1", () => {
    expect(sanitizeDisplayText("a\rB\bC\x07D\u009b2JE")).toBe("aBCD2JE");
  });

  it("strips unterminated OSC and DCS strings", () => {
    expect(sanitizeDisplayText("a\x1b]0;title")).toBe("a");
    expect(sanitizeDisplayText("b\x1bPpayload")).toBe("b");
  });

  it("full sanitize is idempotent", () => {
    const dirty = "\x1b[1m*\x1b[0m\x1f\n中文";
    const clean = sanitizeDisplayText(dirty);
    expect(sanitizeDisplayText(clean)).toBe(clean);
    expect(clean).toBe("*\n中文");
  });
});
