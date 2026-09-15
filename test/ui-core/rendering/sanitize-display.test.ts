import { describe, expect, it } from "vitest";
import {
  sanitizeDisplayText,
  sanitizeDisplayTextChunks,
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
    expect(sanitizeDisplayText("\x1b[31")).toBe("");
    expect(sanitizeDisplayText("\x1b") + sanitizeDisplayText("[31mred")).toBe(
      "[31mred",
    );
  });

  it("drops cursor controls, BEL, carriage return, backspace, and C1", () => {
    expect(sanitizeDisplayText("a\rB\bC\x07D\u009b2JE")).toBe("aBCDE");
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

  it.each(["\x1bP", "\x1bX", "\x1b^", "\x1b_", "\x90", "\x98", "\x9e", "\x9f"])(
    "removes terminal control-string payloads introduced by %j",
    (start) => {
      expect(sanitizeDisplayText(`before${start}binary-looking payload\x1b\\after`)).toBe("beforeafter");
      expect(sanitizeDisplayText(`before${start}incomplete payload`)).toBe("before");
    },
  );

  it("strips C1 color, hyperlink and character-set controls", () => {
    expect(sanitizeDisplayText("\x9b32m✓\x9b0m \x9d8;;https://example.test\x9clink\x9d8;;\x9c \x1b(0text\x1b(B"))
      .toBe("✓ link text");
  });

  it("sanitizes escapes split across styled chunks without losing styles", () => {
    const chunks = [
      { text: "✓ \x1b[", color: "green" },
      { text: "32mtests", color: "blue" },
      { text: "\x1b]0;window", color: "red" },
      { text: " title\x07 passed", color: "yellow" },
    ];
    expect(sanitizeDisplayTextChunks(chunks)).toEqual([
      { text: "✓ ", color: "green" },
      { text: "tests", color: "blue" },
      { text: "", color: "red" },
      { text: " passed", color: "yellow" },
    ]);
    expect(chunks[0]?.text).toBe("✓ \x1b[");
  });
});
