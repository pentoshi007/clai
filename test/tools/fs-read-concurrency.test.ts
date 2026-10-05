import { describe, expect, it, vi } from "vitest";
import { fsRead } from "../../src/tools/fs/read.js";
import { fsReadMany } from "../../src/tools/fs/read-many.js";
import { parseFsReadSections } from "../../src/tools/fs/read-sections.js";
import type { ToolResult } from "../../src/types.js";

vi.mock("../../src/tools/fs/read.js", () => ({ fsRead: vi.fn() }));

describe("multi-file read scheduling", () => {
  it("bounds concurrent disk work while retaining request order after out-of-order completion", async () => {
    const pending = new Map<string, (result: ToolResult) => void>();
    let active = 0;
    let peak = 0;
    vi.mocked(fsRead).mockImplementation((path) => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => pending.set(path, (result) => { active -= 1; resolve(result); }));
    });
    const files = Array.from({ length: 6 }, (_, index) => ({ path: `${index}.ts` }));
    const running = fsReadMany(files);
    expect([...pending.keys()]).toEqual(["0.ts", "1.ts", "2.ts"]);
    for (const path of ["2.ts", "1.ts", "3.ts", "0.ts", "5.ts", "4.ts"]) {
      pending.get(path)!({ ok: true, output: `contents ${path}` });
      await Promise.resolve();
    }
    const result = await running;
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(parseFsReadSections(result.output).map((section) => section.body)).toEqual(files.map((file) => `contents ${file.path}`));
    for (const [, options] of vi.mocked(fsRead).mock.calls) expect(options?.maxBytes).toBeLessThanOrEqual(256 * 1024 / 6);
  });

  it("does not schedule later files after interruption and drains started reads", async () => {
    vi.mocked(fsRead).mockClear();
    const pending: Array<(result: ToolResult) => void> = [];
    vi.mocked(fsRead).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const controller = new AbortController();
    const running = fsReadMany(Array.from({ length: 6 }, (_, index) => ({ path: `${index}.ts` })), { signal: controller.signal });
    const stopped = expect(running).rejects.toThrow("stop reading");
    controller.abort(new Error("stop reading"));
    for (const finish of pending) finish({ ok: true, output: "already read" });
    await stopped;
    expect(fsRead).toHaveBeenCalledTimes(3);
  });
});
