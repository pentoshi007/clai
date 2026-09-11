import { describe, expect, it } from "vitest";
import { layoutPickerOptions, pickerItemAtRow, pickerScrollTop, pickerWindow } from "../../../src/ui-core/rendering/picker-layout.js";
import { overlaySize } from "../../../src/ui-core/layout/overlay-size.js";
import { renderColumns } from "../../../src/ui-core/rendering/text-width.js";

describe("expanded overlay geometry", () => {
  it.each([[120, 40], [80, 24], [32, 10], [8, 4], [1, 1]])("fits %i by %i with only a small cell margin", (columns, rows) => {
    const size = overlaySize(columns, rows);
    expect(size.width + size.marginX * 2).toBe(columns);
    expect(size.height + size.marginY * 2).toBe(rows);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    expect(size.marginX).toBeLessThanOrEqual(2);
    expect(size.marginY).toBeLessThanOrEqual(1);
  });
});

describe("virtual picker window", () => {
  const items = layoutPickerOptions(Array.from({ length: 10000 }, (_, index) => ({
    value: String(index), label: `Option ${index}`, description: "Description\nSecond row",
  })), 40, true);

  it.each([0, 42, 15000, 29999])("allocates only viewport rows and overscan at offset %i", (top) => {
    const window = pickerWindow(items, top, 10);
    expect(window.rows.length).toBeLessThanOrEqual(14);
    expect(window.before + window.rows.length + window.after).toBe(30000);
    for (const [offset, row] of window.rows.entries()) {
      expect(items[row.itemIndex]!.top + row.lineIndex).toBe(window.before + offset);
    }
  });

  it("slices an oversized single option rather than mounting all of its lines", () => {
    const tall = layoutPickerOptions([{ value: "tall", label: "Title", description: "detail\n".repeat(10000) + "LAST" }], 40, true);
    const window = pickerWindow(tall, 5000, 1);
    expect(window.rows).toHaveLength(5);
    expect(window.rows.every((row) => row.itemIndex === 0)).toBe(true);
    expect(pickerWindow(tall, 20000, 1).rows.at(-1)?.line.text).toBe("LAST");
  });

  it("handles empty lists and exact item boundaries", () => {
    expect(pickerWindow([], 100, 10)).toEqual({ before: 0, after: 0, rows: [] });
    expect(pickerItemAtRow([], 0)).toBe(-1);
    expect(pickerItemAtRow(items, 2)).toBe(0);
    expect(pickerItemAtRow(items, 3)).toBe(1);
    expect(pickerItemAtRow(items, 30000)).toBe(9999);
  });
});

describe("wrapped picker options", () => {
  it.each([80, 30, 12, 3, 1])("preserves complete commands and descriptions at %i columns", (width) => {
    const label = `rg --files ${"nested/".repeat(20)} --glob '*.ts'`;
    const description = "Inspect all matching files and keep the complete command visible. ".repeat(6);
    const items = layoutPickerOptions([{ value: "scan", label, description }], width, true);
    const lines = items[0]!.lines;
    expect(lines.map((line) => line.text).join("")).toBe(label + description);
    for (const line of lines) expect(renderColumns(line.text)).toBeLessThanOrEqual(width);
    expect(lines.some((line) => line.text.includes("…"))).toBe(false);
  });

  it("wraps unicode by terminal cells and reuses unchanged option wrapping", () => {
    const options = [{ value: "u", label: "界面 👩‍💻 café ".repeat(8), description: "description" }];
    const first = layoutPickerOptions(options, 12, true);
    expect(first[0]!.lines.every((line) => renderColumns(line.text) <= 10)).toBe(true);
    expect(layoutPickerOptions(options, 12, true)[0]!.lines).toBe(first[0]!.lines);
    expect(layoutPickerOptions(options, 20, true)[0]!.lines).not.toBe(first[0]!.lines);
  });

  it("does not jump to the bottom of an option taller than the viewport", () => {
    const items = layoutPickerOptions([{ value: "long", label: "word ".repeat(60) }], 20, false);
    expect(pickerScrollTop(items, 0, 3, 0)).toBe(0);
    expect(pickerScrollTop(items, 0, 3, 6)).toBe(6);
  });
});
