import { afterEach, describe, expect, it, vi } from "vitest";
import { styleAnsiLine } from "../../../src/tui-v2/rendering/styled-markdown.js";
import { RenderCache } from "../../../src/ui-core/rendering/render-cache.js";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

afterEach(() => vi.restoreAllMocks());

describe("styled render cache memory", () => {
  it("does not retain per-character concatenation trees", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const probe = fileURLToPath(new URL("../../fixtures/retained-style-probe.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--expose-gc", "--import", "tsx/esm", probe],
      { cwd: root, timeout: 30_000 },
    );
    expect(JSON.parse(stdout).retainedBytes).toBeLessThan(24 * 1024 * 1024);
  }, 40_000);

  it("retains hot styles across entry eviction", () => {
    const hot = styleAnsiLine("hot", "#ffffff");
    for (let index = 0; index < 4200; index += 1) {
      styleAnsiLine(`entry ${index}`, "#ffffff");
      expect(styleAnsiLine("hot", "#ffffff")).toBe(hot);
    }
  });

  it("bounds rich text retention without changing evicted text or styling", () => {
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
    const source = "\x1b[31mred\x1b[0mplain".repeat(200);
    const first = styleAnsiLine(source, "#ffffff");
    for (let frame = 0; frame < 100; frame += 1) {
      const styled = styleAnsiLine(`${source}${frame}`, "#ffffff");
      expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe("redplain".repeat(200) + frame);
      set.mockClear();
    }
    expect(insertedWeight).toBeGreaterThan(8 * 1024 * 1024);
    expect(retainedWeight).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(retainedEntries).toBeLessThan(100);
    const replay = styleAnsiLine(source, "#ffffff");
    expect(replay).not.toBe(first);
    expect(replay).toEqual(first);
  });
});
