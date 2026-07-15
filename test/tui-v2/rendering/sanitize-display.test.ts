import { describe, expect, it } from "vitest";
import {
  sanitizeDisplayText,
  stripAnsiSequences,
  stripControlChars,
} from "../../../src/tui-v2/rendering/sanitize-display.js";

describe("sanitizeDisplayText", () => {
  it("strips CSI color sequences", () => {
    expect(stripAnsiSequences("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips OSC title sequences", () => {
    expect(stripAnsiSequences("hi\x1b]0;title\x07there")).toBe("hithere");
  });

  it("keeps tab and newline", () => {
    expect(sanitizeDisplayText("a\tb\nc")).toBe("a\tb\nc");
  });

  it("drops null and DEL", () => {
    expect(stripControlChars("a\x00b\x7fc")).toBe("abc");
  });

  it("full sanitize is idempotent", () => {
    const dirty = "\x1b[1m*\x1b[0m\x1f\n中文";
    const clean = sanitizeDisplayText(dirty);
    expect(sanitizeDisplayText(clean)).toBe(clean);
    expect(clean).toBe("*\n中文");
  });
});
