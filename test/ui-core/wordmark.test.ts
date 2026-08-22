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
  renderWordmark("CLAI", { indent: "", size, style })
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
    expect(wordmarkWidth("CLAI")).toBe(29);
    expect(wordmarkWidth("CLAI", "large")).toBe(41);
    for (const size of ["compact", "large"] as const) {
      for (const style of ["block", "ascii"] as const) {
        for (const row of rows(size, style)) {
          expect(renderColumns(row)).toBeLessThanOrEqual(
            wordmarkWidth("CLAI", size),
          );
        }
      }
    }
  });

  it("draws two-pixel strokes at the compact size", () => {
    expect(rows("compact")).toEqual([
      "▄████▄  ██     ▄████▄  ██████",
      "██      ██     ██  ██    ██  ",
      "██      ██     ██████    ██  ",
      "▀████▀  █████  ██  ██  ██████",
    ]);
  });

  it("draws three-pixel strokes at the large size", () => {
    expect(rows("large")).toEqual([
      "▄███████▄  ███       ▄███████▄  █████████",
      "███▀▀▀▀▀▀  ███       ███▀▀▀███  ▀▀▀███▀▀▀",
      "███        ███       ███   ███     ███   ",
      "███        ███       █████████     ███   ",
      "███▄▄▄▄▄▄  ███▄▄▄▄▄  ███▀▀▀███  ▄▄▄███▄▄▄",
      "▀███████▀  ████████  ███   ███  █████████",
    ]);
  });

  it("uses only block glyphs in block style and hashes in ascii style", () => {
    for (const size of ["compact", "large"] as const) {
      for (const row of rows(size)) expect(row).toMatch(/^[ ▄█▀]+$/);
      for (const row of rows(size, "ascii")) expect(row).toMatch(/^[ #]+$/);
    }
  });

  it("sweeps the ramp left to right, from brand magenta to brand cyan", () => {
    for (const size of ["compact", "large"] as const) {
      const painted =
        renderWordmark("CLAI", { indent: "", size }).split("\n")[0] ?? "";
      const colors = painted.match(/\x1b\[38;2;[0-9;]+m/g) ?? [];
      expect(colors.length).toBeGreaterThan(3);
      expect(colors[0]).toBe("\x1b[38;2;255;85;255m");
      expect(colors.at(-1)).toBe("\x1b[38;2;46;235;255m");
    }
    expect(WORDMARK_TOP_HEX).toBe("#FF55FF");
  });

  it("indents every row", () => {
    for (const row of renderWordmark("CLAI", { indent: "    " }).split("\n")) {
      expect(stripAnsi(row).startsWith("    ")).toBe(true);
    }
  });
});
