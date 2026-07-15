import { describe, expect, it } from "vitest";
import {
  countComposerVisualLines,
  maxComposerTextRows,
  resolveComposerTextRows,
} from "../../../src/tui-v2/composer/composer-height.js";

describe("countComposerVisualLines", () => {
  it("returns 1 for empty input", () => {
    expect(countComposerVisualLines("", 80)).toBe(1);
  });

  it("counts Shift+Enter hard newlines", () => {
    expect(countComposerVisualLines("hello\nworld\n!", 80)).toBe(3);
  });

  it("soft-wraps long single lines to multiple rows", () => {
    expect(countComposerVisualLines("a".repeat(20), 8)).toBeGreaterThan(1);
  });

  it("combines newlines and width wrap", () => {
    const text = `${"a".repeat(10)}\nshort`;
    expect(countComposerVisualLines(text, 5)).toBeGreaterThan(2);
  });
});

describe("resolveComposerTextRows", () => {
  it("stays at 1 when content is a single line", () => {
    expect(resolveComposerTextRows(1, 16)).toBe(1);
  });

  it("grows with content up to the max budget", () => {
    expect(resolveComposerTextRows(4, 16)).toBe(4);
    expect(resolveComposerTextRows(20, 16)).toBe(16);
  });

  it("never drops below minRows", () => {
    expect(resolveComposerTextRows(0, 8)).toBe(1);
  });
});

describe("maxComposerTextRows", () => {
  it("leaves room for status, chat floor, and border chrome", () => {
    // 40 term - 1 status - 6 chat - 2 borders = 31, capped at 16
    expect(
      maxComposerTextRows({
        terminalRows: 40,
        statusHeight: 1,
        minChatRows: 6,
        maxCap: 16,
      }),
    ).toBe(16);
  });

  it("shrinks on short terminals", () => {
    expect(
      maxComposerTextRows({
        terminalRows: 12,
        statusHeight: 1,
        minChatRows: 6,
        maxCap: 16,
      }),
    ).toBe(3); // 12 - 1 - 6 - 2
  });

  it("never returns less than 1", () => {
    expect(
      maxComposerTextRows({
        terminalRows: 4,
        statusHeight: 1,
        minChatRows: 6,
        maxCap: 16,
      }),
    ).toBe(1);
  });
});
