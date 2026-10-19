import fc from "fast-check";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { renderColumns, terminalWidth } from "../../../src/ui-core/rendering/text-width.js";

const fragments = [
  "a", " ", "1", "#", "*", "日", "🧪", "\u0301", "\u200d", "\uFE0F", "\u20E3", "👍", "🏽",
  "\x1b[1m", "\x1b[0m", "\x1b[38;2;1;2;3m", "\x1b]8;;https://example.test\x07", "\t", "é", "한", "🇺", "🇸", "Ａ",
  "\x1b]0;window title, with spaces\x07", "\u009b31m", "\u0085", "\u0600", "\u0D4E", "\u{110BD}", "\r", "\n",
];

describe("terminal width fast path", () => {
  it.each([
    "", "plain ascii", "e\u0301", "1\uFE0F\u20E3", "#\uFE0F\u20E3", "日本語 🧪 **bold**", "a👍🏽b", "👨‍👩‍👧 x",
    "\x1b[31mred\x1b[0m 日本", "\x1b]8;;https://example.test\x07link\x1b]8;;\x07", "tab\there", "a\u200bb",
    "Ａｂ", "한국어 text", "🇺🇸flag", "x\u0300\u0301y",
    "\x1b]0;window title, with spaces\x07ok", "\x1b]8;;https://example.test/a,b\x07link\x1b]8;;\x07",
    "\u009b31mred", "\u0D4Ek", "x\u0D4Ek\u0301y", "\u{110BD}1", "a\r\nb",
  ])("matches string-width for %j", (text) => {
    expect(terminalWidth(text)).toBe(stringWidth(text));
  });

  it("matches string-width for arbitrary mixed text and escapes", () => {
    fc.assert(fc.property(fc.array(fc.oneof(fc.constantFrom(...fragments), fc.string()), { maxLength: 30 }), (parts) => {
      const text = parts.join("");
      expect(terminalWidth(text)).toBe(stringWidth(text));
    }), { numRuns: 2000 });
  });

  it("keeps layout columns at least the plain code-unit length", () => {
    expect(renderColumns("\x1b[1mabc\x1b[0m")).toBe(3);
    expect(renderColumns("日本")).toBe(4);
    expect(renderColumns("e\u0301")).toBe(2);
  });
});
