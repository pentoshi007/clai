import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveProjectRoot } from "../../src/agent/project-root.js";
import { boundedOutput, executeReadOnlyCall, prepareReadOnlyCall, READ_ONLY_TOOLS } from "../../src/agent/subagents/read-only-tools.js";
import { runToolCall } from "../../src/tools/registry.js";

describe("confined child read-only tools", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "child-read-tools-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "export const answer = 42;\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses real registry search and read without changing parent cwd or project root", async () => {
    const cwd = process.cwd();
    const project = getActiveProjectRoot();
    const search = await prepareReadOnlyCall(root, { name: "fs.search", args: { path: "src", pattern: "answer" } });
    const result = await executeReadOnlyCall(root, search, runToolCall, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(join(root, "src/example.ts"));
    expect(result.output).not.toContain("# no matches");
    const read = await prepareReadOnlyCall(root, { name: "fs.read", args: { path: "src/example.ts", offset: 1, limit: 10 } });
    const evidence = await executeReadOnlyCall(root, read, runToolCall, { confirmed: true });
    expect(evidence.ok).toBe(true);
    expect(evidence.output).toContain("1: export const answer = 42;");
    expect(process.cwd()).toBe(cwd);
    expect(getActiveProjectRoot()).toBe(project);
    expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe("export const answer = 42;\n");
  });

  it("never dispatches recursive search targets or symlinks to the registry", async () => {
    await symlink(join(root, "src/example.ts"), join(root, "src/link.ts"));
    const execute = vi.fn(async () => ({ ok: true, output: "match" }));
    const safe = await prepareReadOnlyCall(root, { name: "fs.search", args: { pattern: "answer", path: "src" } });
    await executeReadOnlyCall(root, safe, execute, {});
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({ name: "fs.search", args: { path: join(root, "src/example.ts") } });
  });

  it("caps traversal and reports missing coverage", async () => {
    await Promise.all(Array.from({ length: 70 }, (_, i) => writeFile(join(root, "src", `f${i}.ts`), "answer")));
    const execute = vi.fn(async () => ({ ok: true, output: "# no matches\n" }));
    const safe = await prepareReadOnlyCall(root, { name: "fs.search", args: { pattern: "unknown", path: "src" } });
    const result = await executeReadOnlyCall(root, safe, execute, {});
    expect(execute).toHaveBeenCalledTimes(64);
    expect(result.output).toContain("traversal limit");
  });

  it("rejects envelope, nested, symlink and write options instead of dropping them", async () => {
    for (const args of [
      { path: "src/example.ts", input: { name: "fs.write" } },
      { path: "src/example.ts", content: "overwrite" },
      { path: "src/example.ts", followSymlinks: true },
    ]) {
      await expect(prepareReadOnlyCall(root, { name: "fs.read", args })).rejects.toThrow("Argument denied");
    }
    await expect(prepareReadOnlyCall(root, { name: "web.fetch", args: { url: "file:///etc/passwd" } })).rejects.toThrow("HTTP(S)");
    await expect(prepareReadOnlyCall(root, { name: "web.search", args: { query: "docs", fetchTop: 3 } })).rejects.toThrow("Argument denied");
  });

  it("only advertises narrow tools and clamps output and paging limits", async () => {
    expect(READ_ONLY_TOOLS.every((tool) => tool.parameters.additionalProperties === false)).toBe(true);
    expect(READ_ONLY_TOOLS.find((tool) => tool.name === "fs.search")!.parameters.properties).not.toHaveProperty("fileList");
    const read = await prepareReadOnlyCall(root, { name: "fs.read", args: { path: "src/example.ts", limit: 9999, maxBytes: 1_000_000 } });
    expect(read.args).toMatchObject({ limit: 300, maxBytes: 12_000 });
    expect(boundedOutput("x".repeat(13_000))).toHaveLength(12_000);
    expect(boundedOutput("x".repeat(13_000))).toContain("Coverage is incomplete");
  });

  it("guards the registry boundary even for unprepared denied calls", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: "unexpected execution" }));
    for (const name of ["shell", "fs.write", "tool.batch", "fs_read", "http.request", "subagent.spawn"]) {
      await expect(executeReadOnlyCall(root, { name, args: {} }, execute, {})).rejects.toThrow("Tool denied");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds direct registry output and rejects a stopped execution", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: "x".repeat(50_000) }));
    const safe = await prepareReadOnlyCall(root, { name: "fs.read", args: { path: "src/example.ts" } });
    const result = await executeReadOnlyCall(root, safe, execute, {});
    expect(result.output).toHaveLength(12_000);
    const signal = AbortSignal.abort(new Error("stop requested"));
    await expect(executeReadOnlyCall(root, safe, execute, { signal })).rejects.toThrow("stop requested");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects oversized line-window reads before the registry buffers the file", async () => {
    await writeFile(join(root, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    const execute = vi.fn(async () => ({ ok: true, output: "unexpected read" }));
    const safe = await prepareReadOnlyCall(root, { name: "fs.read", args: { path: "large.txt", offset: 1, limit: 1 } });
    await expect(executeReadOnlyCall(root, safe, execute, {})).rejects.toThrow("2 MiB read limit");
    expect(execute).not.toHaveBeenCalled();
  });
});
