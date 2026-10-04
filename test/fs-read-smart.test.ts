import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsRead } from "../src/tools/fs.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "clai-fsread-smart-"));
  dirs.push(d);
  return d;
}

describe("fs.read smart windows", () => {
  it("returns a full small file", async () => {
    const dir = tempDir();
    const path = join(dir, "small.ts");
    writeFileSync(path, "const x = 1;\nconst y = 2;\n");
    const result = await fsRead(path);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("const x = 1");
    expect(result.output).toContain("const y = 2");
    expect(result.truncated).toBeFalsy();
  });

  it("pages with offset/limit and numbered lines (streaming)", async () => {
    const dir = tempDir();
    const path = join(dir, "lines.txt");
    writeFileSync(
      path,
      Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n"),
    );
    const result = await fsRead(path, { offset: 10, limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("10: line-10");
    expect(result.output).toContain("14: line-14");
    expect(result.output).not.toContain("9: line-9");
    expect(result.output).toMatch(/hasMore=true/);
    expect(result.output).toContain('"offset":15');
  });

  it("accepts startLine/endLine aliases", async () => {
    const dir = tempDir();
    const path = join(dir, "alias.txt");
    writeFileSync(path, "a\nb\nc\nd\ne\n");
    const result = await fsRead(path, { startLine: 2, endLine: 4 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("2: b");
    expect(result.output).toContain("4: d");
    expect(result.output).not.toContain("1: a");
  });

  it("past-EOF range returns a helpful empty success (no blind retry)", async () => {
    const dir = tempDir();
    const path = join(dir, "short.txt");
    writeFileSync(path, "only\ntwo\n");
    const result = await fsRead(path, { offset: 100, limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/only .*2 line/i);
  });

  it("rejects endLine < startLine", async () => {
    const dir = tempDir();
    const path = join(dir, "x.txt");
    writeFileSync(path, "a\nb\n");
    const result = await fsRead(path, { startLine: 5, endLine: 2 });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/startLine\/offset <= endLine/);
  });

  it("pattern mode returns numbered context around hits", async () => {
    const dir = tempDir();
    const path = join(dir, "src.ts");
    writeFileSync(
      path,
      ["// header", "function foo() {", "  return 1;", "}", "function bar() {}"].join(
        "\n",
      ),
    );
    const result = await fsRead(path, {
      pattern: "function\\s+foo",
      context: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/function foo/);
    expect(result.output).toMatch(/matches=1/);
    // context before
    expect(result.output).toMatch(/header/);
  });

  it("invalid regex fails closed with a clear message", async () => {
    const dir = tempDir();
    const path = join(dir, "x.txt");
    writeFileSync(path, "hello\n");
    const result = await fsRead(path, { pattern: "(unclosed" });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Invalid regex/i);
  });

  it("empty pattern fails clearly", async () => {
    const dir = tempDir();
    const path = join(dir, "x.txt");
    writeFileSync(path, "hello\n");
    const result = await fsRead(path, { pattern: "   " });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/non-empty/i);
  });

  it("auto-heads large files instead of dumping the whole body", async () => {
    const dir = tempDir();
    const path = join(dir, "big.log");
    // > 256KB soft full-read threshold
    const line = "x".repeat(200) + "\n";
    const body = line.repeat(2000); // ~400KB
    writeFileSync(path, body);
    const result = await fsRead(path);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toMatch(/auto-head/i);
    expect(result.output).toMatch(/hasMore=true|next=/);
    // Must not return the entire multi-hundred-KB body
    expect((result.output ?? "").length).toBeLessThan(100_000);
  });

  it("refuses binary/NUL content", async () => {
    const dir = tempDir();
    const path = join(dir, "blob.bin");
    writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    const result = await fsRead(path);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Binary|non-text/i);
  });

  it("caps pattern maxMatches", async () => {
    const dir = tempDir();
    const path = join(dir, "many.txt");
    writeFileSync(
      path,
      Array.from({ length: 30 }, () => "HIT line").join("\n"),
    );
    const result = await fsRead(path, {
      pattern: "HIT",
      maxMatches: 3,
      context: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/matches=3/);
    expect(result.output).toMatch(/hasMore=true|capped/i);
  });

  it("accepts /pattern/flags form and offset 0", async () => {
    const dir = tempDir();
    const path = join(dir, "slash.txt");
    writeFileSync(path, "alpha\nHello World\nomega\n");
    const slash = await fsRead(path, { pattern: "/hello/i", context: 0 });
    expect(slash.ok).toBe(true);
    expect(slash.output).toMatch(/Hello World/);

    const zero = await fsRead(path, { offset: 0, limit: 2 });
    expect(zero.ok).toBe(true);
    expect(zero.output).toContain("1: alpha");
    expect(zero.output).toMatch(/1-indexed|treated as 1/i);
  });
});
