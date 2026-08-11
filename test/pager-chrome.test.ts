import { describe, expect, it } from "vitest";
import { padChromeRow } from "../src/ui-core/rendering/pager-chrome.js";

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
});
