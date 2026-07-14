import { describe, expect, it } from "vitest";
import {
  shouldNavigateHistoryDown,
  shouldNavigateHistoryUp,
} from "../../../src/tui-v2/composer/history-nav.js";

describe("shouldNavigateHistoryUp", () => {
  it("is true on the first line", () => {
    expect(shouldNavigateHistoryUp({ line: 0, lineCount: 3 })).toBe(true);
  });

  it("is false below the first line", () => {
    expect(shouldNavigateHistoryUp({ line: 1, lineCount: 3 })).toBe(false);
  });
});

describe("shouldNavigateHistoryDown", () => {
  it("is true on the last line", () => {
    expect(shouldNavigateHistoryDown({ line: 2, lineCount: 3 })).toBe(true);
  });

  it("is false above the last line", () => {
    expect(shouldNavigateHistoryDown({ line: 0, lineCount: 3 })).toBe(false);
  });

  it("is true for a single-line buffer", () => {
    expect(shouldNavigateHistoryUp({ line: 0, lineCount: 1 })).toBe(true);
    expect(shouldNavigateHistoryDown({ line: 0, lineCount: 1 })).toBe(true);
  });
});
