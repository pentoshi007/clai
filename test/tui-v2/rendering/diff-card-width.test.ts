import { describe, expect, it } from "vitest";
import {
  clipDiffCardText,
  diffCardMaxLineChars,
  gutterWidth,
  presentFileChangePreview,
} from "../../../src/ui-core/rendering/file-diff-view.js";
import { buildFileChange } from "../../../src/tools/file-diff.js";

/**
 * OpenTUI text renderables never clip at their box, so an over-long diff line
 * draws straight through the card's right border (the reported "text reaches
 * the rightmost border and breaks it"). The diff card must pre-wrap every row
 * to the real chat-pane width. These tests pin the budget math and the clip
 * helper; scripts/v2-spikes/diff-card-overflow.spike.tsx proves the rendered
 * frame under the native OpenTUI renderer.
 */
describe("diffCardMaxLineChars", () => {
  it("subtracts card chrome and the gutter from the pane width", () => {
    expect(diffCardMaxLineChars(40, 1)).toBe(32);
    expect(diffCardMaxLineChars(80, 3)).toBe(70);
  });

  it("keeps border + padding + gutter + separator + code exactly within the pane", () => {
    const paneWidth = 55;
    const gutterChars = 2;
    const used = 4 + gutterChars + 3 + diffCardMaxLineChars(paneWidth, gutterChars);
    expect(used).toBe(paneWidth);
  });

  it("never budgets below wrapCodeLine's hard chop floor", () => {
    expect(diffCardMaxLineChars(12, 5)).toBe(8);
    expect(diffCardMaxLineChars(0, 0)).toBe(8);
  });

  it("no longer derives the budget from the raw terminal width", () => {
    // Tasks-pane-open shape: 100-col terminal, 40-col chat pane.
    const legacyBudget = Math.max(16, 100 - 1 - 6);
    expect(diffCardMaxLineChars(40, 1)).toBe(32);
    expect(diffCardMaxLineChars(40, 1)).toBeLessThan(legacyBudget);
  });
});

describe("clipDiffCardText", () => {
  it("leaves text that fits untouched", () => {
    expect(clipDiffCardText("src/tui-v2/app/App.tsx", 40)).toBe("src/tui-v2/app/App.tsx");
  });

  it("clips overflow with a trailing ellipsis within the budget", () => {
    const clipped = clipDiffCardText("z".repeat(50), 10);
    expect(clipped).toBe("z".repeat(9) + "…");
    expect(clipped.length).toBe(10);
  });

  it("handles degenerate budgets", () => {
    expect(clipDiffCardText("abc", 1)).toBe("…");
    expect(clipDiffCardText("abc", 0)).toBe("");
    expect(clipDiffCardText("abc", -1)).toBe("");
  });

  it("does not split surrogate pairs", () => {
    const clipped = clipDiffCardText("👍".repeat(10), 5);
    const chars = [...clipped];
    expect(chars).toHaveLength(5);
    expect(chars.every((c) => c === "…" || c.codePointAt(0)! > 0xffff)).toBe(true);
  });
});

describe("presentFileChangePreview fits the diff card budget", () => {
  const change = buildFileChange({
    path: "/tmp/demo/module.ts",
    before: "",
    after: [
      `const endpoint = "https://api.example.com/v1/${"z".repeat(60)}/tokens";`,
      "const x = 1;",
    ].join("\n"),
    kind: "create",
  });

  it("wraps every code row within the pane budget (words split in parts)", () => {
    const paneWidth = 40;
    const gw = gutterWidth(change);
    const budget = diffCardMaxLineChars(paneWidth, gw);
    const rows = presentFileChangePreview(change, { maxLineChars: budget });

    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      expect(row.displayText.length).toBeLessThanOrEqual(budget);
      expect(row.gutter.length).toBe(gw);
    }
    // The long token is chopped into parts across rows, never one long line,
    // and no characters are dropped.
    expect(rows.map((r) => r.displayText).join("")).toContain("z".repeat(60));
    expect(rows.map((r) => r.displayText).join("")).toContain('/tokens";');
  });
});
