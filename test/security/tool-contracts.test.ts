import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { OutputDecoder, spawnArgv, shellExec } from "../../src/tools/shell.js";
import { fsEdit, fsAppend, fsSearch } from "../../src/tools/fs.js";
import { getToolDefinitions } from "../../src/tools/definitions.js";

let dir: string;
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clai-contracts-"));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
});

describe("TOOL-003 shell output decoding", () => {
  it("does not corrupt a multi-byte character split across chunks", () => {
    const decoder = new OutputDecoder();
    const full = Buffer.from("héllo — wörld ✅", "utf8");
    let text = "";
    for (let i = 0; i < full.length; i += 3) {
      text += decoder.decode(full.subarray(i, i + 3)).text;
    }
    text += decoder.end();
    expect(text).toBe("héllo — wörld ✅");
  });

  it("counts real bytes, not UTF-16 code units", () => {
    const decoder = new OutputDecoder();
    const chunk = Buffer.from("✅✅", "utf8");
    expect(decoder.decode(chunk).bytes).toBe(chunk.byteLength);
    expect(chunk.byteLength).toBeGreaterThan("✅✅".length);
  });

  it("flags binary content", () => {
    const decoder = new OutputDecoder();
    decoder.decode(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));
    expect(decoder.isBinary).toBe(true);
  });

  it("suppresses binary command output with a marker", async () => {
    const result = await shellExec({
      command: "printf '\\000\\001\\002\\003binary'",
      timeoutMs: 10_000,
    });
    expect(result.output).toMatch(/binary output suppressed/i);
  });
});

describe("TOOL-003 artifact permissions", () => {
  it("writes command artifacts as 0600", async () => {
    if (platform() === "win32") return;
    const artifactPath = join(dir, "artifact.txt");
    await shellExec({
      command: "echo hello",
      artifactPath,
      timeoutMs: 10_000,
    });
    const st = await stat(artifactPath);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("TOOL-003 timeoutMs is opt-in per tool", () => {
  it("omits timeoutMs from tools that ignore it", () => {
    const defs = getToolDefinitions();
    const byName = new Map(defs.map((d) => [d.name, d]));
    for (const name of ["fs.read", "fs.write", "fs.list", "shell.start"]) {
      const props = byName.get(name)?.parameters.properties ?? {};
      expect(Object.keys(props)).not.toContain("timeoutMs");
    }
    expect(
      Object.keys(byName.get("shell.start")?.parameters.properties ?? {}),
    ).not.toContain("responder");
    for (const name of ["shell.exec", "http.fetch", "pdf.read", "image.ocr"]) {
      const props = byName.get(name)?.parameters.properties ?? {};
      expect(Object.keys(props)).toContain("timeoutMs");
    }
  });

  it("documents pdf/image OCR knobs that the implementation reads", () => {
    const defs = getToolDefinitions();
    const pdf = defs.find((d) => d.name === "pdf.read");
    const image = defs.find((d) => d.name === "image.ocr");
    expect(Object.keys(pdf?.parameters.properties ?? {})).toEqual(
      expect.arrayContaining(["maxPages", "lang", "dpi", "psm"]),
    );
    expect(Object.keys(pdf?.parameters.properties ?? {})).not.toContain(
      "maxBytes",
    );
    expect(Object.keys(image?.parameters.properties ?? {})).toEqual(
      expect.arrayContaining(["lang", "psm"]),
    );
  });
});

describe("TOOL-003 large-file mutation guards", () => {
  it("refuses a whole-file fs.edit above the size limit", async () => {
    const file = join(dir, "huge.sql");
    // Sparse-ish: write a 9MB buffer.
    await writeFile(file, Buffer.alloc(9 * 1024 * 1024, 0x61));
    const result = await fsEdit(file, "aaa", "bbb", 1, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/whole-file edit limit/i);
    expect(result.output).toMatch(/fs\.replaceLines/);
  });

  it("appends in place above the size limit and says the diff was skipped", async () => {
    const file = join(dir, "huge.log");
    await writeFile(file, Buffer.alloc(9 * 1024 * 1024, 0x0a));
    const result = await fsAppend(file, "tail line\n", { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/appended in place/i);
    const text = await readFile(file, "utf8");
    expect(text.endsWith("tail line\n")).toBe(true);
  });
});

describe("TOOL-003 fs.search", () => {
  it("treats a leading-dash pattern as a pattern, not a flag", async () => {
    await writeFile(join(dir, "a.txt"), "keep --flaglike value\n", "utf8");
    const result = await fsSearch("--flaglike", dir, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/flaglike/);
  });

  it("supports glob, case-insensitive and files-only filters", async () => {
    await writeFile(join(dir, "one.ts"), "export const Alpha = 1;\n", "utf8");
    await writeFile(join(dir, "two.md"), "alpha\n", "utf8");
    const scoped = await fsSearch("alpha", dir, {
      confirmed: true,
      glob: "*.ts",
      caseInsensitive: true,
    });
    expect(scoped.output).toMatch(/one\.ts/);
    expect(scoped.output).not.toMatch(/two\.md/);

    const filesOnly = await fsSearch("alpha", dir, {
      confirmed: true,
      caseInsensitive: true,
      filesOnly: true,
    });
    expect(filesOnly.output).not.toMatch(/:\d+:/);
  });
});

describe("TOOL-003 spawnArgv launch failures are structured", () => {
  it("returns an actionable result instead of throwing", async () => {
    const result = await spawnArgv({
      command: "clai-definitely-missing-binary-xyz",
      argv: ["--version"],
      timeoutMs: 5_000,
      noArtifact: true,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
    expect(result.output).toMatch(/not found on PATH/i);
  });
});
