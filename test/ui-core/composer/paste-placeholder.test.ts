import { describe, expect, it } from "vitest";
import {
  PasteRegistry,
  isLargePaste,
  pasteChipLabel,
  pastePreviewLines,
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
