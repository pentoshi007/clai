import { describe, expect, it } from "vitest";
import {
  USER_MESSAGE_CHROME_COLS,
  wrapUserPrompt,
} from "../../src/ui-core/rendering/user-message-wrap.js";

describe("wrapUserPrompt", () => {
  it("never drops characters when the chat column is narrow (tasks pane open)", () => {
    const text =
      "the text color should also change on changing day/night theme. use static color instead of hardcoded values so the UI stays readable.";
    // Simulate a reduced chat width beside a ~40-col tasks pane.
    const contentWidth = 72;
    const lines = wrapUserPrompt(text, contentWidth);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("").replace(/\s+/g, " ").trim()).toBe(
      text.replace(/\s+/g, " ").trim(),
    );
    const maxLine = Math.max(...lines.map((l) => l.length));
    expect(maxLine).toBeLessThanOrEqual(
      Math.max(12, contentWidth - USER_MESSAGE_CHROME_COLS),
    );
  });

  it("keeps short prompts on one line", () => {
    expect(wrapUserPrompt("hi", 80)).toEqual(["hi"]);
  });

  it("preserves hard newlines", () => {
    const lines = wrapUserPrompt("first line\nsecond line", 80);
    expect(lines).toEqual(["first line", "second line"]);
  });
});
