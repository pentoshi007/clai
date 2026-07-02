import { describe, expect, it } from "vitest";
import { wrapAnsiLine, visibleWidth } from "../src/ui/markdown.js";

/**
 * Regression test for the Ctrl+P plan pager truncating long lines with "…"
 * instead of wrapping them. Root cause: Pager.tsx pre-wrapped body lines to
 * `cols - 15`, but every rendered line also carries a " 1234 │ " line-number
 * prefix (7 more visible columns) that was never subtracted from the wrap
 * budget — so a fully-wrapped line plus its prefix still overflowed the
 * terminal width, and Ink's own `wrap="truncate-end"` silently truncated it.
 *
 * This test exercises the exact width arithmetic Pager.tsx now uses and
 * asserts no line, once the prefix is added back, can exceed the terminal.
 */
describe("Pager line-wrap width accounting", () => {
  const LINE_PREFIX_WIDTH = 7; // "1234 │ "

  function usableWidthFor(cols: number): number {
    return Math.max(10, cols - 15 - LINE_PREFIX_WIDTH);
  }

  it("keeps every wrapped line + its line-number prefix within the terminal width", () => {
    const cols = 100;
    const usableWidth = usableWidthFor(cols);
    const longLine =
      "This is a very long plan detail line that describes fuzzing hidden directories, " +
      "checking security headers, and analyzing client-side code for sensitive information " +
      "across the entire target surface area in one continuous sentence.";

    const wrapped = wrapAnsiLine(longLine, usableWidth);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) {
      const withPrefix = visibleWidth(line) + LINE_PREFIX_WIDTH;
      expect(withPrefix).toBeLessThanOrEqual(cols - 8); // outer+inner border/padding budget
    }
  });

  it("still wraps correctly on a narrow terminal", () => {
    const cols = 60;
    const usableWidth = usableWidthFor(cols);
    const longLine = "a".repeat(200);
    const wrapped = wrapAnsiLine(longLine, usableWidth);
    for (const line of wrapped) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(usableWidth);
    }
  });

  it("does not need Ink's truncate-end fallback for normal prose", () => {
    // If wrapAnsiLine's output already fits, the pager's wrap="truncate-end"
    // (a safety net for pathological unbreakable tokens) never has to
    // truncate normal content — this is what "not showing full, shows ..."
    // was actually caused by.
    const cols = 120;
    const usableWidth = usableWidthFor(cols);
    const line = "Perform a comprehensive vulnerability assessment on aniketpandey.website including directory fuzzing.";
    const wrapped = wrapAnsiLine(line, usableWidth);
    const rejoined = wrapped.join(" ");
    expect(rejoined.replace(/\s+/g, " ")).toContain("vulnerability assessment");
    expect(rejoined).not.toContain("…");
  });
});
