import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveProjectRoot } from "../../src/agent/project-root.js";
import { boundedOutput, executeReadOnlyCall, prepareReadOnlyCall, READ_ONLY_TOOLS } from "../../src/agent/subagents/read-only-tools.js";
import { runToolCall } from "../../src/tools/registry.js";

describe("child tools for context gathering", () => {
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

  it("blocks fs.delete and fs.edit from execution", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: "unexpected execution" }));
    for (const name of ["fs.delete", "fs.edit", "subagent.start", "subagent.wait"]) {
      await expect(prepareReadOnlyCall(root, { name, args: {} })).rejects.toThrow("Tool denied");
      await expect(executeReadOnlyCall(root, { name, args: {} }, execute, {})).rejects.toThrow("Tool denied");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(READ_ONLY_TOOLS.some((tool) => tool.name === "fs.delete")).toBe(false);
    expect(READ_ONLY_TOOLS.some((tool) => tool.name === "fs.edit")).toBe(false);
  });

  it("clamps output and paging limits", async () => {
    const read = await prepareReadOnlyCall(root, { name: "fs.read", args: { path: "src/example.ts", limit: 9999, maxBytes: 1_000_000 } });
    expect(read.args).toMatchObject({ limit: 300, maxBytes: 12_000 });
    expect(boundedOutput("x".repeat(13_000))).toHaveLength(12_000);
    expect(boundedOutput("x".repeat(13_000))).toContain("Coverage is incomplete");
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

  it("allows normal shell composition, redirection, absolute paths, and git commands", async () => {
    for (const command of [
      'grep -rn "answer" src 2>/dev/null | head -20',
      'grep pattern src > /dev/null',
      "cat a; cat b",
      "cat a && cat b",
      "cat /etc/passwd | head -2",
      "git tag --sort=-version:refname | head -10",
      "git describe --tags --always",
    ]) {
      const safe = await prepareReadOnlyCall(root, { name: "shell.exec", args: { command, timeoutMs: 60_000 } });
      expect(safe.args).toMatchObject({ command, timeoutMs: 60_000, background: "never" });
      expect(String((safe.args as Record<string, unknown>).cwd)).toContain("child-read-tools-");
    }
    const safe = await prepareReadOnlyCall(root, { name: "shell.exec", args: { command: 'grep -rn "answer" src | head -20' } });
    const execute = vi.fn(async () => ({ ok: true, output: "match" }));
    const result = await executeReadOnlyCall(root, safe, execute, {});
    expect(execute).toHaveBeenCalledOnce();
    expect(result.output).toBe("match");
  });

  it("allows reading absolute paths outside cwd", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: "outside content" }));
    const safe = await prepareReadOnlyCall(root, { name: "fs.read", args: { path: "/tmp/outside.txt" } });
    const result = await executeReadOnlyCall(root, safe, execute, {});
    expect(execute).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });
});
