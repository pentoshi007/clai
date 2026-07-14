import { describe, expect, it } from "vitest";
import {
  PasteRegistry,
  isLargePaste,
} from "../../../src/tui-v2/composer/paste-placeholder.js";

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

describe("PasteRegistry", () => {
  it("registers a placeholder with line/char stats", () => {
    const registry = new PasteRegistry();
    const entry = registry.register("a\nb\nc");
    expect(entry.lines).toBe(3);
    expect(entry.chars).toBe(5);
    expect(entry.token).toContain("+3 lines");
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
