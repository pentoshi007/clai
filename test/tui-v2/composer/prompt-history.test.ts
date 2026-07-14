import { describe, expect, it } from "vitest";
import { PromptHistory } from "../../../src/tui-v2/composer/prompt-history.js";

describe("PromptHistory", () => {
  it("returns undefined when browsing an empty history", () => {
    const h = new PromptHistory();
    expect(h.prev("draft")).toBeUndefined();
  });

  it("does not record consecutive duplicates", () => {
    const h = new PromptHistory();
    h.push("hello");
    h.push("hello");
    expect(h.size).toBe(1);
  });

  it("records non-consecutive duplicates", () => {
    const h = new PromptHistory();
    h.push("a");
    h.push("b");
    h.push("a");
    expect(h.size).toBe(3);
  });

  it("walks backward from newest to oldest and saves the draft", () => {
    const h = new PromptHistory();
    h.push("first");
    h.push("second");
    expect(h.prev("in progress")).toBe("second");
    expect(h.prev("in progress")).toBe("first");
    // Already at the oldest entry — stays put.
    expect(h.prev("in progress")).toBe("first");
  });

  it("restores the draft after walking past the newest entry", () => {
    const h = new PromptHistory();
    h.push("first");
    h.push("second");
    h.prev("draft text"); // now on "second"
    h.prev("draft text"); // now on "first"
    expect(h.next()).toBe("second");
    expect(h.next()).toBe("draft text");
    expect(h.isBrowsing()).toBe(false);
  });

  it("next() is a no-op when not browsing", () => {
    const h = new PromptHistory();
    h.push("first");
    expect(h.next()).toBeUndefined();
  });

  it("reset() clears browsing state", () => {
    const h = new PromptHistory();
    h.push("first");
    h.prev("draft");
    h.reset();
    expect(h.isBrowsing()).toBe(false);
  });
});
