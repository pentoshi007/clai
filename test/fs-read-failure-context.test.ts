import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatToolContext } from "../src/agent/tool-output-formatting.js";
import { parseFsReadSections } from "../src/tools/fs/read-sections.js";
import { runToolCall } from "../src/tools/registry.js";
import type { ToolCall } from "../src/types.js";

const SOURCE = [
  'const failure = new Error("fatal: example file content");',
  'const message = "FAILED ENOENT exception panic timeout";',
  "if (controlCloseTimer) clearTimeout(controlCloseTimer);",
].join("\n");

let root: string;
let paths: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-read-failure-"));
  paths = ["first.ts", "second.ts", "third.ts"].map((name) => join(root, name));
  await Promise.all(paths.map((path) => writeFile(path, SOURCE)));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fs.read failure diagnostics", () => {
  it.each(["single", "range", "pattern", "multi"])("treats error-related text as successful file content in %s reads", async (mode) => {
    const args = mode === "multi" ? { files: paths.map((path) => ({ path })) }
      : { path: paths[0], ...(mode === "range" ? { offset: 1, limit: 3 } : {}), ...(mode === "pattern" ? { pattern: "Error|FAILED|clearTimeout", context: 0 } : {}) };
    const call: ToolCall = { name: "fs.read", args };
    const result = await runToolCall(call);
    expect(result.ok).toBe(true);
    expect(result.exitCode ?? 0).toBe(0);
    const context = formatToolContext(call, result);
    expect(context).not.toContain("FAILURE SUMMARY:");
    expect(context).toContain("clearTimeout(controlCloseTimer)");
    if (mode === "multi") expect(parseFsReadSections(context).every((section) => section.ok)).toBe(true);
  });

  it.each([0, 1, 2])("reports only the actual failed file at position %i without quoting successful source", async (failedIndex) => {
    const missing = join(root, "missing.d.ts");
    const files = paths.map((path, index) => index === failedIndex
      ? { path: missing, pattern: "type OnLoad|interface OnLoad|resolveDir", context: 3, maxMatches: 10 }
      : { path, offset: 1, limit: 3 });
    const call: ToolCall = { name: "fs.read", args: { files } };
    const result = await runToolCall(call);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const context = formatToolContext(call, result);
    const summary = context.split("\n")[0]!;
    expect(summary).toContain("FAILURE SUMMARY: exit=1");
    expect(summary).toContain(`file ${failedIndex + 1}/3`);
    expect(summary).toContain("ENOENT");
    expect(summary).not.toMatch(/clearTimeout|controlCloseTimer|fatal: example|const message/);
    const sections = parseFsReadSections(context);
    expect(sections.map((section) => section.ok)).toEqual(paths.map((_, index) => index !== failedIndex));
    for (const section of sections.filter((section) => section.ok)) expect(section.body).toContain("clearTimeout(controlCloseTimer)");
  });

  it("keeps each real failure visible without using the successful middle file as evidence", async () => {
    const files = [{ path: join(root, "missing-one.ts") }, { path: paths[1] }, { path: join(root, "missing-two.ts") }];
    const call: ToolCall = { name: "fs.read", args: { files } };
    const result = await runToolCall(call);
    const summary = formatToolContext(call, result).split("\n")[0]!;
    expect(summary).toContain("file 1/3");
    expect(summary).toContain("file 3/3");
    expect(summary.match(/ENOENT/g)).toHaveLength(2);
    expect(summary).not.toContain("clearTimeout");
  });

  it("keeps a genuine single-file read error marked as failed", async () => {
    const call: ToolCall = { name: "fs.read", args: { path: join(root, "missing.ts") } };
    const result = await runToolCall(call);
    expect(result.ok).toBe(false);
    expect(formatToolContext(call, result).split("\n")[0]).toContain("ENOENT");
  });
});
