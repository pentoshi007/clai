import { describe, expect, it } from "vitest";
import {
  PasteRegistry,
  isLargePaste,
  pasteChipLabel,
  pastePreviewLines,
  countLines,
} from "../../../src/ui-core/composer/paste-placeholder.js";

describe("isLargePaste", () => {
  it("is false for a short single-line paste", () => {
    expect(isLargePaste("hello world")).toBe(false);
  });

  it("is true past the line threshold", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(isLargePaste(text)).toBe(true);
  });

  it("is true past the character threshold even on one line", () => {
    expect(isLargePaste("x".repeat(900))).toBe(true);
  });

  it("respects custom thresholds", () => {
    expect(isLargePaste("abc\ndef", { lines: 1 })).toBe(true);
    expect(isLargePaste("abc\ndef", { lines: 5 })).toBe(false);
  });
});

describe("pasteChipLabel / pastePreviewLines", () => {
  it("counts and previews large content without splitting every line into an array", () => {
    const text = `first\n\n${"漢字 👩🏽‍💻\n".repeat(100_000)}`;
    expect(countLines(text)).toBe(100_003);
    expect(pastePreviewLines(text)).toEqual(["first", " "]);
    expect(pastePreviewLines(`${"x".repeat(100_000)}\nlast`)).toEqual([`${"x".repeat(71)}…`, "last"]);
  });
  it("labels multi-line pastes for the blue chip", () => {
    expect(pasteChipLabel(10, 100)).toBe("10 lines pasted");
    expect(pasteChipLabel(1, 50)).toBe("50 chars pasted");
  });

  it("previews the first two lines for hover", () => {
    const preview = pastePreviewLines("alpha\nbeta\ngamma\ndelta", 2);
    expect(preview).toEqual(["alpha", "beta"]);
  });
});

describe("PasteRegistry", () => {
  it("never recursively expands placeholder-like text inside a pasted transcript", () => {
    const registry = new PasteRegistry();
    const a = registry.register("Pasted log mentions [3 chars pasted #2] verbatim");
    const b = registry.register("BBB");
    expect(registry.expand(`${a.token} ${b.token}`)).toBe(`${a.text} BBB`);
  });
  it("registers a placeholder with line/char stats", () => {
    const registry = new PasteRegistry();
    const entry = registry.register("a\nb\nc");
    expect(entry.lines).toBe(3);
    expect(entry.chars).toBe(5);
    expect(entry.label).toBe("3 lines pasted");
    expect(entry.token).toContain("3 lines pasted");
  });

  it("assigns increasing ids across registrations", () => {
    const registry = new PasteRegistry();
    const a = registry.register("one");
    const b = registry.register("two");
    expect(b.id).toBe(a.id + 1);
  });

  it("resolves a registered entry by id", () => {
    const registry = new PasteRegistry();
    const entry = registry.register("full text");
    expect(registry.resolve(entry.id)?.text).toBe("full text");
  });

  it("expands placeholder tokens back to full text for submission", () => {
    const registry = new PasteRegistry();
    const entry = registry.register("the real pasted content");
    const buffer = `before ${entry.token} after`;
    expect(registry.expand(buffer)).toBe(
      "before the real pasted content after",
    );
  });

  it("expands a single paste on double-click", () => {
    const registry = new PasteRegistry();
    const a = registry.register("AAA");
    const b = registry.register("BBB");
    const buffer = `${a.token} mid ${b.token}`;
    expect(registry.expandOne(buffer, a.id)).toBe(`AAA mid ${b.token}`);
  });

  it("expands only the nearest occurrence, even when a token appears twice", () => {
    const registry = new PasteRegistry();
    const entry = registry.register("full pasted text");
    const buffer = `${entry.token} between ${entry.token} after`;
    const cursor = buffer.lastIndexOf(entry.token) + 5;
    expect(registry.expandNearest(buffer, cursor)).toEqual({
      text: `${entry.token} between full pasted text after`,
      cursor: entry.token.length + " between full pasted text".length,
    });
  });

  it("prefers the preceding block at equal distance, regardless of registration order", () => {
    const registry = new PasteRegistry();
    const right = registry.register("right");
    const left = registry.register("left");
    const buffer = `${left.token}  ${right.token}`;
    const cursor = left.token.length + 1;
    expect(registry.expandNearest(buffer, cursor)).toEqual({
      text: `left  ${right.token}`,
      cursor: "left ".length,
    });
  });

  it("preserves the cursor and Unicode prose outside the expanded block", () => {
    const registry = new PasteRegistry();
    const entry = registry.register("漢字\n👩🏽‍💻 é pasted");
    const prefix = "before 👩🏽‍💻 ";
    const buffer = `${prefix}${entry.token} after`;
    expect(registry.expandNearest(buffer, 0)?.cursor).toBe(0);
    expect(registry.expandNearest(buffer, buffer.length)).toEqual({
      text: `${prefix}${entry.text} after`,
      cursor: prefix.length + entry.text.length + " after".length,
    });
    expect(registry.expandNearest("ordinary text", 4)).toBeUndefined();
  });

  it("lists only pastes still present in the buffer", () => {
    const registry = new PasteRegistry();
    const a = registry.register("AAA");
    const b = registry.register("BBB");
    expect(registry.activeIn(a.token).map((e) => e.id)).toEqual([a.id]);
    expect(registry.activeIn(`${a.token} ${b.token}`).map((e) => e.id)).toEqual(
      [a.id, b.id],
    );
  });

  it("expands multiple distinct placeholders", () => {
    const registry = new PasteRegistry();
    const a = registry.register("AAA");
    const b = registry.register("BBB");
    expect(registry.expand(`${a.token} ${b.token}`)).toBe("AAA BBB");
  });

  it("clear() drops all registered entries", () => {
    const registry = new PasteRegistry();
    const entry = registry.register("x");
    registry.clear();
    expect(registry.resolve(entry.id)).toBeUndefined();
  });
});
