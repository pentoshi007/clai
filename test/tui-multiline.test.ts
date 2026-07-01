import { describe, expect, it } from "vitest";
import { wrapPlainString } from "../src/tui/text-format.js";

// Shift+Enter inserts a literal "\n" into the composer input. These tests
// pin the behaviour the composer relies on to render that multi-line input:
// wrapPlainString must split on newlines and keep character indices aligned
// so the cursor lands on the right visual line.
describe("multi-line composer input (shift+enter)", () => {
  it("splits a newline-separated string into one line per paragraph", () => {
    const lines = wrapPlainString("hello\nworld", 80);
    expect(lines.map((l) => l.lineText)).toEqual(["hello", "world"]);
  });

  it("keeps char offsets aligned across the newline for cursor mapping", () => {
    const input = "ab\ncd";
    const lines = wrapPlainString(input, 80);
    // "ab" occupies indices 0..2, the "\n" is index 2, "cd" starts at 3.
    expect(lines[0]).toMatchObject({ lineText: "ab", startIdx: 0, endIdx: 2 });
    expect(lines[1]).toMatchObject({ lineText: "cd", startIdx: 3, endIdx: 5 });
  });

  it("renders an empty line for a trailing newline", () => {
    const lines = wrapPlainString("done\n", 80);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ lineText: "", startIdx: 5, endIdx: 5 });
  });

  it("still wraps long single paragraphs on width", () => {
    const lines = wrapPlainString("a".repeat(10), 4);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((l) => l.lineText).join("")).toBe("a".repeat(10));
  });
});
