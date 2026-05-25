import { describe, expect, it, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fsEdit, fsDelete } from "../src/tools/fs.js";

// Use cwd-relative temp dirs so they pass the write sandbox check.
// The write sandbox allows process.cwd() and its children.
function makeTempDir(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.test-tmp-${prefix}-`));
}

describe("fsEdit", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it("replaces exactly one occurrence", async () => {
    const dir = makeTempDir("fsedit");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "hello world\ngoodbye world\n");

    const result = await fsEdit(file, "hello", "hi");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1 occurrence");
    const content = readFileSync(file, "utf8");
    expect(content).toBe("hi world\ngoodbye world\n");
  });

  it("fails on zero matches", async () => {
    const dir = makeTempDir("fsedit");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "hello world\n");

    const result = await fsEdit(file, "NOTFOUND", "replacement");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("No matches");
  });

  it("fails when count mismatches expected", async () => {
    const dir = makeTempDir("fsedit");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "aaa bbb aaa\n");

    const result = await fsEdit(file, "aaa", "ccc");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("2 occurrence");
    // File should be unchanged
    expect(readFileSync(file, "utf8")).toBe("aaa bbb aaa\n");
  });

  it("replaces multiple when expectedReplacements matches", async () => {
    const dir = makeTempDir("fsedit");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "aaa bbb aaa\n");

    const result = await fsEdit(file, "aaa", "ccc", 2);
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("ccc bbb ccc\n");
  });
});

describe("fsDelete", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it("deletes a file", async () => {
    const dir = makeTempDir("fsdel");
    dirs.push(dir);
    const file = join(dir, "delete-me.txt");
    writeFileSync(file, "goodbye");

    const result = await fsDelete(file);
    expect(result.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("fails gracefully for non-existent files", async () => {
    const dir = makeTempDir("fsdel");
    dirs.push(dir);
    const result = await fsDelete(join(dir, "nonexistent.txt"));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Delete failed");
  });

  it("deletes a directory recursively", async () => {
    const dir = makeTempDir("fsdel");
    dirs.push(dir);
    const subdir = join(dir, "subdir");
    mkdirSync(subdir);
    writeFileSync(join(subdir, "file.txt"), "content");

    const result = await fsDelete(subdir, true);
    expect(result.ok).toBe(true);
    expect(existsSync(subdir)).toBe(false);
  });
});
