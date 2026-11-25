import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ObjectRenderCache } from "../../../src/ui-core/rendering/object-render-cache.js";

describe("object render cache ownership", () => {
  it("evicts the least recently used live layout, not its source", () => {
    const cache = new ObjectRenderCache<object, string>(300);
    const a = {}, b = {}, c = {};
    cache.set(a, "80", "first", 20);
    cache.set(b, "80", "second", 20);
    expect(cache.get(a, "80")).toBe("first");
    cache.set(c, "80", "third", 20);
    expect(cache.get(b, "80")).toBeUndefined();
    expect(cache.get(c, "100")).toBeUndefined();
    cache.clear();
    expect(cache.weight).toBe(0);
    expect(cache.get(a, "80")).toBeUndefined();
  });

  it("does not pin superseded transcript items until byte-budget eviction", () => {
    const probe = `import {ObjectRenderCache} from ${JSON.stringify(new URL("../../../src/ui-core/rendering/object-render-cache.ts", import.meta.url).href)};
      const cache = new ObjectRenderCache(1048576), keys = [];
      function render() {
        const item = { body: Buffer.alloc(262144) };
        keys.push(new WeakRef(item));
        cache.set(item, '80', { item }, 64);
      }
      for (let i = 0; i < 64; i++) render();
      await new Promise(setImmediate); global.gc(); await new Promise(setImmediate); global.gc();
      console.log(JSON.stringify({ live: keys.filter(ref => ref.deref()).length, weight: cache.weight }));`;
    const result = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", probe], { encoding: "utf8" }));
    expect(result.weight).toBeGreaterThan(0);
    expect(result.live).toBe(0);
  });
});
