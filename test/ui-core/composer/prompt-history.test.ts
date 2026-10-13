import { describe, expect, it } from "vitest";
import { PromptHistory } from "../../../src/ui-core/composer/prompt-history.js";

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

  it("recalls saved prompts lazily after current-launch entries and restores the draft", async () => {
    const h = new PromptHistory();
    const saved = ["old second", "old first"];
    h.setOlderSource(async () => saved.shift());
    h.push("new prompt");
    expect(await h.prevWithSaved("draft")).toBe("new prompt");
    expect(await h.prevWithSaved("draft")).toBe("old second");
    expect(await h.prevWithSaved("draft")).toBe("old first");
    expect(await h.nextWithSaved()).toBe("old second");
    expect(await h.nextWithSaved()).toBe("new prompt");
    expect(await h.nextWithSaved()).toBe("draft");
  });

  it("serializes queued history keys while reading from disk", async () => {
    const h = new PromptHistory();
    const saved = ["third", "second", "first"];
    h.setOlderSource(async () => saved.shift());
    expect(await Promise.all([h.prevWithSaved("draft"), h.prevWithSaved("draft"), h.prevWithSaved("draft")]))
      .toEqual(["third", "second", "first"]);
  });

  it("does not replace an edited draft with a late read, or skip that saved entry later", async () => {
    const h = new PromptHistory();
    let finish!: (value: string) => void;
    h.setOlderSource(() => new Promise((resolve) => { finish = resolve; }));
    const recall = h.prevWithSaved("old draft");
    await Promise.resolve();
    h.reset();
    finish("saved prompt");
    expect(await recall).toBeUndefined();
    expect(await h.prevWithSaved("edited draft")).toBe("saved prompt");
    expect(await h.nextWithSaved()).toBe("edited draft");
  });

  it("discards a late read from a replaced or disabled source", async () => {
    const h = new PromptHistory();
    let finish!: (value: string) => void;
    h.setOlderSource(() => new Promise((resolve) => { finish = resolve; }));
    const recall = h.prevWithSaved("draft");
    await Promise.resolve();
    h.setOlderSource(undefined);
    finish("old saved prompt");
    expect(await recall).toBeUndefined();
    expect(h.size).toBe(0);
  });
});
