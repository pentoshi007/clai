import { describe, expect, it } from "vitest";
import { RenderCache } from "../../../src/ui-core/rendering/render-cache.js";

describe("RenderCache", () => {
  it("evicts the least recently used entry without clearing hot renders", () => {
    const cache = new RenderCache<object>(2, 10_000);
    const hot = {};
    cache.set("hot", hot, 1);
    cache.set("cold", {}, 1);
    expect(cache.get("hot")).toBe(hot);
    cache.set("next", {}, 1);
    expect(cache.get("cold")).toBeUndefined();
    expect(cache.get("hot")).toBe(hot);
    expect(cache.size).toBe(2);
  });

  it("bounds retained text and object weight across a long stream", () => {
    const budget = 64 * 1024;
    const cache = new RenderCache<string>(4096, budget);
    for (let frame = 0; frame < 10_000; frame += 1) {
      const text = `${frame}:` + "界".repeat(2048 + frame % 8192);
      cache.set(text, text, text.length * 2);
      expect(cache.get(text)).toBe(text);
      expect(cache.weight).toBeLessThanOrEqual(budget);
      expect(cache.size).toBeLessThan(10);
    }
  });

  it("does not retain oversized entries or evict useful entries for them", () => {
    const cache = new RenderCache<string>(10, 512);
    cache.set("small", "small", 10);
    const weight = cache.weight;
    cache.set("large", "x".repeat(1024), 2048);
    expect(cache.get("large")).toBeUndefined();
    expect(cache.get("small")).toBe("small");
    expect(cache.weight).toBe(weight);
  });

  it("accounts for replacements and keys, including empty values", () => {
    const cache = new RenderCache<string>(10, 1024);
    cache.set("a", "large", 100);
    const before = cache.weight;
    cache.set("a", "", 0);
    expect(cache.get("a")).toBe("");
    expect(cache.weight).toBe(before - 100);
    cache.set("a", "uncached", 2000);
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
    cache.set("x".repeat(1024), "", 0);
    expect(cache.size).toBe(0);
  });

  it("rejects invalid budgets and weights without corrupting entries", () => {
    for (const invalid of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => new RenderCache(10, invalid)).toThrow(RangeError);
      expect(() => new RenderCache(invalid, 1000)).toThrow(RangeError);
    }
    const cache = new RenderCache<string>(10, 1000);
    cache.set("key", "value", 10);
    const weight = cache.weight;
    for (const invalid of [-1, NaN, Infinity, 1.5]) {
      expect(() => cache.set("key", "other", invalid)).toThrow(RangeError);
      expect(cache.get("key")).toBe("value");
      expect(cache.weight).toBe(weight);
    }
  });
});
