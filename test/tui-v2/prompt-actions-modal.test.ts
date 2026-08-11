import { describe, expect, it } from "vitest";
import { preparePromptPreview } from "../../src/ui-core/rendering/prompt-preview.js";

describe("preparePromptPreview", () => {
  it("soft-wraps long lines to the column budget", () => {
    const long = "word ".repeat(40).trim();
    const { lines, truncated } = preparePromptPreview(long, 20, 50);
    expect(truncated).toBe(false);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it("caps lines and marks truncation with an ellipsis", () => {
    const many = Array.from({ length: 30 }, (_, i) => `line-${i} ${"x".repeat(30)}`).join(
      "\n",
    );
    const { lines, truncated, totalLines } = preparePromptPreview(many, 24, 6);
    expect(truncated).toBe(true);
    expect(totalLines).toBeGreaterThan(6);
    expect(lines).toHaveLength(6);
    expect(lines[lines.length - 1]).toMatch(/…$/);
  });

  it("preserves short prompts without truncation", () => {
    const { lines, truncated } = preparePromptPreview("hello world", 40, 8);
    expect(truncated).toBe(false);
    expect(lines).toEqual(["hello world"]);
  });
});
