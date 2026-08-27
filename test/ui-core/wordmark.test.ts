import chalk from "chalk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderColumns } from "../../src/ui-core/rendering/text-width.js";
import {
  WORDMARK_TOP_HEX,
  renderWordmark,
  wordmarkWidth,
  type WordmarkSize,
  type WordmarkStyle,
} from "../../src/ui-core/rendering/wordmark.js";

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;]*m/g, "");

const rows = (
  size: WordmarkSize = "compact",
  style: WordmarkStyle = "block",
): string[] =>
  renderWordmark("clai", { indent: "", size, style })
    .split("\n")
    .map(stripAnsi);

describe("wordmark", () => {
  const previousLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it("offers a four-row and a six-row size", () => {
    expect(rows("compact")).toHaveLength(4);
    expect(rows("large")).toHaveLength(6);
    expect(rows("compact", "ascii")).toHaveLength(4);
    expect(rows("large", "ascii")).toHaveLength(6);
  });

  it("reports a width every row honors", () => {
    expect(wordmarkWidth("clai")).toBe(22);
    expect(wordmarkWidth("clai", "large")).toBe(30);
    for (const size of ["compact", "large"] as const) {
      for (const style of ["block", "ascii"] as const) {
        for (const row of rows(size, style)) {
          expect(renderColumns(row)).toBeLessThanOrEqual(
            wordmarkWidth("clai", size),
          );
        }
      }
    }
  });

  it("draws two-pixel strokes at the compact size", () => {
    expect(rows("compact")).toEqual([
      " ▄▄▄▄   ██   ▄▄▄▄   ██",
      "██      ██   ▄▄▄██    ",
      "██      ██  ██  ██  ██",
      "▀█▄▄▄   ██  ▀█▄▄██  ██",
    ]);
  });

  it("draws three-pixel strokes at the large size", () => {
    expect(rows("large")).toEqual([
      "           ███             ███",
      " ▄▄▄▄▄▄▄   ███   ▄▄▄▄▄▄▄      ",
      "███▀▀▀▀▀▀  ███        ███  ███",
      "███        ███  ▄██▀▀▀███  ███",
      "███        ███  ███   ███  ███",
      "▀███████▀  ███  ▀██▄▄▄███  ███",
    ]);
  });

  it("raises the l as an ascender and floats a cursor dot over the i", () => {
    const compact = rows("compact");
    expect(compact[0]).toContain("██");
    expect(compact[0]).toContain("▄");
    expect(compact[0]!.endsWith("██")).toBe(true);
    expect(compact[1]!.endsWith("    ")).toBe(true);
    expect(compact[2]!.endsWith("██")).toBe(true);
    expect(compact[3]!.endsWith("██")).toBe(true);

    const large = rows("large");
    expect(large[0]!.trimEnd().endsWith("███")).toBe(true);
    expect(large[1]!.endsWith("      ")).toBe(true);
    expect(large[5]!.endsWith("███")).toBe(true);
  });

  it("uses only block glyphs in block style and hashes in ascii style", () => {
    for (const size of ["compact", "large"] as const) {
      for (const row of rows(size)) expect(row).toMatch(/^[ ▄█▀]+$/);
      for (const row of rows(size, "ascii")) expect(row).toMatch(/^[ #]+$/);
    }
  });

  it("sweeps an analogous teal-to-cyan ramp with no magenta", () => {
    for (const size of ["compact", "large"] as const) {
      const painted =
        renderWordmark("clai", { indent: "", size }).split("\n")[0] ?? "";
      const codes = painted.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
      expect(codes.length).toBeGreaterThan(3);
      const rgb = codes.map((code) => {
        const [, r, g, b] = code.match(/38;2;(\d+);(\d+);(\d+)/)!;
        return { r: Number(r), g: Number(g), b: Number(b) };
      });
      for (const { r, g, b } of rgb) {
        expect(r).toBeLessThanOrEqual(g);
        expect(r).toBeLessThanOrEqual(b);
      }
      expect(rgb.at(-1)!.b).toBeGreaterThan(rgb[0]!.b);
      expect(codes.at(-1)).toBe("\x1b[38;2;143;239;255m");
    }
    expect(WORDMARK_TOP_HEX).toBe("#12D9B0");
  });

  it("indents every row", () => {
    for (const row of renderWordmark("clai", { indent: "    " }).split("\n")) {
      expect(stripAnsi(row).startsWith("    ")).toBe(true);
    }
  });
});
