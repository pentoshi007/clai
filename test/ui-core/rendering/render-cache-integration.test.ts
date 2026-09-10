import { afterEach, describe, expect, it, vi } from "vitest";
import { codeBlockRows, openCodeFence } from "../../../src/ui-core/rendering/code-block.js";
import { RenderCache } from "../../../src/ui-core/rendering/render-cache.js";
import { stripAnsiSequences } from "../../../src/ui-core/rendering/sanitize-display.js";

afterEach(() => vi.restoreAllMocks());

describe("code render cache memory", () => {
  it("evicts derived rows by weight while reproducing complete text and syntax carry", () => {
    const original = RenderCache.prototype.set;
    let retainedWeight = 0;
    let retainedEntries = 0;
    let insertedWeight = 0;
    const set = vi.spyOn(RenderCache.prototype, "set").mockImplementation(function (
      this: RenderCache<unknown>, key: string, value: unknown, weight: number,
    ) {
      original.call(this, key, value, weight);
      retainedWeight = this.weight;
      retainedEntries = this.size;
      insertedWeight += key.length * 2 + weight;
    });
    const render = (source: string) => {
      const fence = openCodeFence("```", "typescript");
      const rows = codeBlockRows(source, fence, 80, { colorMode: "none" });
      set.mockClear();
      return { rows, carry: fence.carry };
    };
    const source = "/* " + "all-context-preserved ".repeat(400);
    const first = render(source);
    for (let frame = 0; frame < 300; frame += 1) render(`${source}${frame}`);
    expect(insertedWeight).toBeGreaterThan(8 * 1024 * 1024);
    expect(retainedWeight).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(retainedEntries).toBeLessThan(300);
    expect(render(source)).toEqual(first);
    expect(first.carry.inBlockComment).toBe(true);
    const complete = first.rows.map((row) => stripAnsiSequences(row).slice(2, -2).trimEnd()).join("");
    expect(complete.replaceAll(" ", "")).toBe(source.replaceAll(" ", ""));
  });
});
