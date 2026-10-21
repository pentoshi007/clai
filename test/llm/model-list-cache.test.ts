import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fallbackModelList,
  invalidateModelLists,
  isFallbackModelList,
  isModelListFresh,
  MODEL_LIST_TTL_MS,
  modelListCache,
  onModelListInvalidated,
} from "../../src/llm/model-list-cache.js";

const START = 1_900_000_000_000;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(START);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function at(offsetMs: number): void {
  vi.mocked(Date.now).mockReturnValue(START + offsetMs);
}

describe("model list lifetime", () => {
  it("is two minutes", () => {
    expect(MODEL_LIST_TTL_MS).toBe(120_000);
  });

  it("serves a stored list until exactly the lifetime has elapsed", () => {
    const cache = modelListCache("lifetime-a");
    cache.store(["one", "two"]);
    at(MODEL_LIST_TTL_MS - 1);
    expect(cache.fresh()).toEqual(["one", "two"]);
    at(MODEL_LIST_TTL_MS);
    expect(cache.fresh()).toBeUndefined();
  });

  it("lets a caller accept a longer age without extending the default lifetime", () => {
    const cache = modelListCache("lifetime-b");
    cache.store(["one"]);
    at(10 * MODEL_LIST_TTL_MS);
    expect(cache.fresh()).toBeUndefined();
    expect(cache.fresh("", 11 * MODEL_LIST_TTL_MS)).toEqual(["one"]);
  });

  it("keeps the expired list only for callers that explicitly ask for it", () => {
    const cache = modelListCache("lifetime-c");
    cache.store(["one"]);
    at(MODEL_LIST_TTL_MS * 5);
    expect(cache.fresh()).toBeUndefined();
    expect(cache.stale()).toEqual(["one"]);
  });

  it("measures freshness for caches that keep their own state", () => {
    expect(isModelListFresh(START - MODEL_LIST_TTL_MS + 1)).toBe(true);
    expect(isModelListFresh(START - MODEL_LIST_TTL_MS)).toBe(false);
    expect(isModelListFresh(START - 10, 5)).toBe(false);
  });
});

describe("what is allowed into the cache", () => {
  it("never stores an empty list", () => {
    const cache = modelListCache("empty-a");
    cache.store([]);
    expect(cache.fresh()).toBeUndefined();
    expect(cache.stale()).toBeUndefined();
  });

  it("does not let an empty list replace a good one", () => {
    const cache = modelListCache("empty-b");
    cache.store(["good"]);
    cache.store([]);
    expect(cache.fresh()).toEqual(["good"]);
  });

  it("keeps lists for different keys apart and bounds how many it remembers", () => {
    const cache = modelListCache("keys");
    for (let index = 0; index < 20; index += 1) cache.store([`model-${index}`], `key-${index}`);
    expect(cache.fresh("key-0")).toBeUndefined();
    expect(cache.fresh("key-3")).toBeUndefined();
    expect(cache.fresh("key-4")).toEqual(["model-4"]);
    expect(cache.fresh("key-19")).toEqual(["model-19"]);
  });

  it("restarts the lifetime when a key is stored again", () => {
    const cache = modelListCache("restart");
    cache.store(["old"]);
    at(MODEL_LIST_TTL_MS - 1);
    cache.store(["new"]);
    at(MODEL_LIST_TTL_MS + 5);
    expect(cache.fresh()).toEqual(["new"]);
  });
});

describe("invalidation", () => {
  it("clears only the caches of the named provider", () => {
    const first = modelListCache("invalidate-a");
    const second = modelListCache("invalidate-b");
    first.store(["a"]);
    second.store(["b"]);
    invalidateModelLists("invalidate-a");
    expect(first.fresh()).toBeUndefined();
    expect(first.stale()).toBeUndefined();
    expect(second.fresh()).toEqual(["b"]);
  });

  it("clears every cache when no provider is named", () => {
    const first = modelListCache("invalidate-c");
    const second = modelListCache("invalidate-d");
    first.store(["a"]);
    second.store(["b"]);
    invalidateModelLists();
    expect(first.fresh()).toBeUndefined();
    expect(second.fresh()).toBeUndefined();
  });

  it("clears several caches that belong to one provider", () => {
    const first = modelListCache("invalidate-e");
    const second = modelListCache("invalidate-e");
    first.store(["a"]);
    second.store(["b"]);
    invalidateModelLists("invalidate-e");
    expect(first.fresh()).toBeUndefined();
    expect(second.fresh()).toBeUndefined();
  });

  it("runs custom invalidators for state that is not a plain list", () => {
    const reset = vi.fn();
    onModelListInvalidated("invalidate-f", reset);
    invalidateModelLists("invalidate-other");
    expect(reset).not.toHaveBeenCalled();
    invalidateModelLists("invalidate-f");
    expect(reset).toHaveBeenCalledOnce();
  });

  it("leaves detached caches alone", () => {
    const attached = modelListCache("invalidate-g");
    const detached = modelListCache("invalidate-g", { detached: true });
    attached.store(["a"]);
    detached.store(["b"]);
    invalidateModelLists("invalidate-g");
    expect(attached.fresh()).toBeUndefined();
    expect(detached.fresh()).toEqual(["b"]);
  });
});

describe("fallback lists", () => {
  const builtIn = ["built-in-a", "built-in-b"] as const;

  it("are recognised and copied so the shared constant stays untouched", () => {
    const list = fallbackModelList(builtIn);
    expect(list).toEqual(builtIn);
    expect(list).not.toBe(builtIn);
    expect(isFallbackModelList(list)).toBe(true);
    expect(isFallbackModelList(builtIn)).toBe(false);
  });

  it("are never mistaken for a live list", () => {
    expect(isFallbackModelList(["live-a"])).toBe(false);
    expect(isFallbackModelList([])).toBe(false);
  });
});
