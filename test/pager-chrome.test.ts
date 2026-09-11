import { describe, expect, it } from "vitest";
import { padChromeRow, wrapPagerLine } from "../src/ui-core/rendering/pager-chrome.js";
import { renderColumns } from "../src/ui-core/rendering/text-width.js";

describe("padChromeRow", () => {
  it("returns exactly width columns", () => {
    const row = padChromeRow(
      "↑↓:scroll  ·  ^r:search  ·  n/N:next  ·  c:copy  ·  e:editor  ·  q/esc:close  ·  find:npm 1/2",
      "11 lines · top",
      80,
    );
    expect(row.length).toBe(80);
    expect(row.trimEnd().endsWith("top") || row.includes("11 lines")).toBe(true);
  });

  it("keeps line count visible on narrow widths", () => {
    const row = padChromeRow("find:npm 1/2", "11 lines · top", 40);
    expect(row.length).toBe(40);
    expect(row).toMatch(/11/);
  });

  it("never exceeds width with long find + line count", () => {
    const row = padChromeRow(
      "find:verylongsearchtermthatwouldoverflow 1/99",
      "1234 lines · bottom",
      50,
    );
    expect(row.length).toBe(50);
  });

  it.each([1, 2, 4, 7])("fits tiny chrome into %i columns", (width) => {
    expect(renderColumns(padChromeRow("search and close", "100 lines", width))).toBeLessThanOrEqual(width);
  });
});

describe("lossless pager wrapping", () => {
  it.each([1, 3, 8, 24, 80])("preserves complete commands and quoted whitespace at %i columns", (width) => {
    const command = `  printf '%s' '  value    with  spaces  ' | rg --glob '*.ts' ${"nested/path/".repeat(12)}  `;
    const rows = wrapPagerLine(command, width, { preserveWhitespace: true });
    expect(rows.join("")).toBe(command);
    for (const row of rows) expect(renderColumns(row)).toBeLessThanOrEqual(width);
  });
});
