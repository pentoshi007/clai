import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runToolCall } from "../src/tools/registry.js";
import { getToolDefinition } from "../src/tools/definitions.js";
import { fsRead } from "../src/tools/fs.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import { formatToolContext } from "../src/agent/tool-output-formatting.js";
import { completedOperationSignature } from "../src/agent/outcomes.js";
import { recognizeBareToolJson } from "../src/agent/tool-call-parser.js";
import { boundFsReadOutput, formatFsReadSection, parseFsReadSections } from "../src/tools/fs/read-sections.js";
import { boundedOutput, executeReadOnlyCall, prepareReadOnlyCall, READ_ONLY_TOOLS } from "../src/agent/subagents/read-only-tools.js";
import { toGeminiFunctionDeclarations } from "../src/llm/adapters/gemini-tools.js";

let root: string;
const originalSandboxReads = getConfig().sandboxReads;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-multi-read-"));
});

afterEach(async () => {
  updateConfig({ sandboxReads: originalSandboxReads });
  await rm(root, { recursive: true, force: true });
});

const read = (args: Record<string, unknown>, signal?: AbortSignal) => runToolCall({ name: "fs.read", args }, { signal });

describe("fs.read single and multiple inputs", () => {
  it("keeps legacy single-file content and numeric argument coercion", async () => {
    const path = join(root, "single.txt");
    await writeFile(path, "first\nsecond\nthird\n");
    const full = await read({ path });
    expect(full).toEqual(await fsRead(path));
    expect(full.output).toBe("first\nsecond\nthird\n");
    const window = await read({ path, offset: "2", limit: "1" });
    expect(window.ok).toBe(true);
    expect(window.output).toContain("2: second");
    expect(window.output).not.toContain("1: first");
  });

  it("reads six files in order with independent full, range, pattern, byte and directory filters", async () => {
    const paths = ["small.txt", "range.txt", "aliases.txt", "pattern.txt", 'spaced "λ".txt', "nested"].map((name) => join(root, name));
    await Promise.all([
      writeFile(paths[0]!, "whole small file"),
      writeFile(paths[1]!, "a\nb\nc\nd\n"),
      writeFile(paths[2]!, "A\nB\nC\nD\n"),
      writeFile(paths[3]!, "before\nEXPORT function match() {}\nafter\nexport second\n"),
      writeFile(paths[4]!, "abcdefghijk"),
      mkdir(paths[5]!),
    ]);
    await writeFile(join(paths[5]!, "inside.txt"), "inside");
    const result = await read({ files: [
      { path: paths[0] },
      { path: paths[1], offset: 2, limit: 1 },
      { path: paths[2], startLine: 3, endLine: 4 },
      { path: paths[3], pattern: "export", caseInsensitive: true, context: 1, maxMatches: 1 },
      { path: paths[4], maxBytes: 5 },
      { path: paths[5], limit: 1 },
    ] });
    expect(result.ok).toBe(true);
    const sections = parseFsReadSections(result.output);
    expect(sections.map((section) => section.path)).toEqual(paths);
    expect(sections.every((section, index) => section.ok && section.index === index + 1 && section.total === 6)).toBe(true);
    expect(sections[0]!.body).toBe("whole small file");
    expect(sections[1]!.body).toContain("2: b");
    expect(sections[1]!.body).not.toContain("3: c");
    expect(sections[2]!.body).toContain("3: C\n4: D");
    expect(sections[3]!.body).toContain("1: before\n2: EXPORT function match() {}\n3: after");
    expect(sections[3]!.body).toContain("matches=1+");
    expect(sections[4]!.body).toContain("abcde");
    expect(sections[4]!.body).not.toContain("abcdef");
    expect(sections[5]!.body).toContain("inside.txt");
    expect(result.truncated).toBe(true);
  });

  it.each([
    {}, { files: [] }, { files: Array.from({ length: 7 }, () => ({ path: "unused" })) },
    { files: ["unused"] }, { files: [{}] }, { path: "unused", files: [{ path: "other" }] },
    { files: [{ path: "unused" }], limit: 10 },
    { files: [{ path: "unused", options: { limit: 10 } }] },
    { files: [{ path: "unused", offset: -1 }] },
    { path: "unused", maxBytes: "bad" },
  ])("explains malformed inputs before attempting any read: %j", async (args) => {
    const result = await read(args);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Use {"path"');
    expect(result.output).toContain("1–6 relevant files");
    expect(result.output).not.toContain("ENOENT");
  });

  it("preserves successes alongside missing, binary, regex and sandbox failures", async () => {
    updateConfig({ sandboxReads: true });
    const good = join(root, "good.txt");
    const binary = join(root, "binary.bin");
    await Promise.all([writeFile(good, "useful evidence"), writeFile(binary, Buffer.from([0, 1, 2]))]);
    const result = await read({ files: [
      { path: good }, { path: join(root, "missing.txt") }, { path: binary },
      { path: good, pattern: "(unclosed" }, { path: "/var/clai-multi-read-outside.txt" },
    ] });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const sections = parseFsReadSections(result.output);
    expect(sections.map((section) => section.ok)).toEqual([true, false, false, false, false]);
    expect(sections[0]!.body).toBe("useful evidence");
    expect(sections[1]!.body).toContain("ENOENT");
    expect(sections[2]!.body).toContain("Binary");
    expect(sections[3]!.body).toContain("Invalid regex");
    expect(sections[4]!.body).toContain("Read blocked");
  });

  it("bounds giant lines across all six files and marks partial lines with a usable continuation", async () => {
    const paths = Array.from({ length: 6 }, (_, index) => join(root, `${index}.txt`));
    await Promise.all(paths.map((path) => writeFile(path, "λ".repeat(300_000))));
    const result = await read({ files: paths.map((path) => ({ path })) });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThan(280_000);
    const sections = parseFsReadSections(result.output);
    expect(sections).toHaveLength(6);
    for (const section of sections) {
      expect(section.body).toContain("line 1 is incomplete");
      expect(section.body).toContain('next={"offset":1');
      expect(section.body).not.toContain("�");
    }
  });

  it("honors byte bounds for range and pattern reads without dropping clipping information", async () => {
    const path = join(root, "long.txt");
    await writeFile(path, `hit ${"λ".repeat(200)}\nsecond\n`);
    for (const filters of [{ offset: 1, limit: 2 }, { pattern: "hit", context: 1 }]) {
      const result = await read({ files: [{ path, ...filters, maxBytes: 32 }] });
      const body = parseFsReadSections(result.output)[0]!.body;
      expect(result.ok).toBe(true);
      expect(result.truncated).toBe(true);
      expect(body).toContain("maxBytes=32");
      expect(body).toContain("hasMore=true");
      expect(body).not.toContain("�");
    }
  });

  it("preserves BOM content and avoids replacement characters when byte caps split UTF-8 characters", async () => {
    const path = join(root, "unicode.txt");
    await writeFile(path, "\ufeffλ😀END");
    expect((await read({ path })).output).toBe("\ufeffλ😀END");
    const result = await read({ files: [{ path, maxBytes: 6 }] });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(parseFsReadSections(result.output)[0]!.body).toContain("\n\ufeffλ\n");
    expect(result.output).not.toContain("�");
  });

  it("stops an aborted request before opening files", async () => {
    await expect(read({ files: [{ path: join(root, "missing") }] }, AbortSignal.abort(new Error("stopped")))).rejects.toThrow("stopped");
  });
});

describe("multi-file evidence through context limits and child agents", () => {
  it("keeps all six statuses and excerpts when model context is capped", () => {
    const output = Array.from({ length: 6 }, (_, index) => formatFsReadSection({
      index: index + 1, total: 6, path: `src/file${index}.ts`, ok: index !== 2,
      body: `evidence ${index}\n${"detail\n".repeat(20_000)}\n# hasMore=true next={"offset":81,"limit":80}`,
    })).join("\n\n");
    const formatted = formatToolContext({ name: "fs.read", args: { files: [] } }, { ok: false, output, outputPath: "/tmp/artifact.txt" });
    expect(parseFsReadSections(formatted).map((section) => section.ok)).toEqual([true, true, false, true, true, true]);
    for (let index = 0; index < 6; index += 1) expect(formatted).toContain(`evidence ${index}`);
    expect(formatted).toContain("Coverage is incomplete");
    expect(formatted).toContain("Full multi-file output: /tmp/artifact.txt");
    const child = boundedOutput(`Error:\n${output}`);
    expect(child.length).toBeLessThanOrEqual(12_000);
    expect(child).toMatch(/^Error:\n/);
    expect(parseFsReadSections(child)).toHaveLength(6);
    expect(boundFsReadOutput(output, 256).length).toBeLessThanOrEqual(256);
    expect(boundFsReadOutput(output, 256)).toContain("6/6 ok");
  });

  it("resolves each child path and clamps its independent filters without changing parent state", async () => {
    const paths = ["a.txt", "b.txt", "c.txt"];
    await Promise.all(paths.map((path) => writeFile(join(root, path), `child ${path}\n${"line\n".repeat(3000)}`)));
    const cwd = process.cwd();
    const call = { name: "fs.read", args: { files: paths.map((path) => ({ path, offset: 1, limit: 9999, maxBytes: 1_000_000 })) } };
    const prepared = await prepareReadOnlyCall(root, call);
    expect(prepared.args.files).toEqual(paths.map((path) => ({ path: join(root, path), offset: 1, limit: 300, maxBytes: 12_000 })));
    const result = await executeReadOnlyCall(root, call, runToolCall, {});
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(12_000);
    expect(parseFsReadSections(result.output).map((section) => section.path)).toEqual(paths.map((path) => join(root, path)));
    expect(process.cwd()).toBe(cwd);
  });

  it("advertises both inputs consistently across native provider and child tool schemas", () => {
    const tool = getToolDefinition("fs.read")!;
    const child = READ_ONLY_TOOLS.find((entry) => entry.name === "fs.read")!;
    expect(child.parameters.required).toEqual(tool.parameters.required);
    expect(Object.keys(child.parameters.properties)).toEqual(Object.keys(tool.parameters.properties));
    expect(child.parameters.properties.files).toMatchObject({ minItems: 1, maxItems: 6, items: { required: ["path"], additionalProperties: false } });
    const declarations = toGeminiFunctionDeclarations([tool]);
    const files = declarations[0]!.parameters.properties as Record<string, { minItems: number; maxItems: number; items: { required: string[] } }>;
    expect(files.files).toMatchObject({ minItems: 1, maxItems: 6, items: { required: ["path"] } });
    expect(tool.parameters.required).not.toContain("path");
    expect(tool.description).toContain("Do not add irrelevant files");
  });

  it("recognizes bare multi-read args without confusing them with writes and normalizes per-file aliases", () => {
    const args = { files: [{ path: "a.ts", startLine: 2, endLine: 4 }, { path: "b.ts" }] };
    expect(recognizeBareToolJson(JSON.stringify(args))?.call).toEqual({ name: "fs.read", args });
    const write = { files: [{ path: "a.ts", content: "new content" }] };
    expect(recognizeBareToolJson(JSON.stringify(write))?.call).toEqual({ name: "fs.writeMany", args: write });
    expect(completedOperationSignature("fs.read", args)).toBe(completedOperationSignature("fs.read", { files: [{ path: "a.ts", offset: 2, limit: 3 }, { path: "b.ts" }] }));
  });
});
