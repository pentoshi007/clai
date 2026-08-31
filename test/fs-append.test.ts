import { describe, expect, it, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fsAppend } from "../src/tools/fs.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.test-tmp-${prefix}-`));
}

describe("fsAppend", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it("appends to the end of a file by default", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "line 1\n");

    const result = await fsAppend(file, "line 2\n");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Appended (end)");
    expect(result.output).toMatch(/bytes=\d+/);
    const content = readFileSync(file, "utf8");
    expect(content).toBe("line 1\nline 2\n");
  });

  it("appends to the start of a file when position is 'start'", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "line 2\n");

    const result = await fsAppend(file, "line 1\n", { position: "start" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Appended (start)");
    const content = readFileSync(file, "utf8");
    expect(content).toBe("line 1\nline 2\n");
  });

  it("creates the file if it does not exist", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "newfile.txt");

    const result = await fsAppend(file, "hello new file\n");
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/Created /);
    expect(result.output).toMatch(/sha256_12=/);
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toBe("hello new file\n");
  });

  it("fails on invalid position values", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "content");

    const result = await fsAppend(file, "extra", { position: "invalid" as any });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Invalid position");
  });

  it("rejects append when expectedPriorBytes does not match", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "abc");

    const result = await fsAppend(file, "x", { expectedPriorBytes: 99 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("integrity check failed");
  });

  it("appends when expectedPriorBytes matches", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "test.txt");
    writeFileSync(file, "abc");

    const result = await fsAppend(file, "d", { expectedPriorBytes: 3 });
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("abcd");
  });

  it("refuses a stale expectation and reports the real size instead of rebasing", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "chain.txt");
    writeFileSync(file, "abc");

    expect((await fsAppend(file, "A", { expectedPriorBytes: 3 })).ok).toBe(true);

    const stale = await fsAppend(file, "B", { expectedPriorBytes: 3 });
    expect(stale.ok).toBe(false);
    expect(stale.output).toContain("expected prior bytes=3");
    expect(stale.output).toContain("actual=4");
    expect(stale.output).toContain("expectedPriorBytes=4");
    expect(readFileSync(file, "utf8")).toBe("abcA");
  });

  it("cannot duplicate a chunk when a distinct append is retried at its old base", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "retry.txt");
    writeFileSync(file, "abc");

    await fsAppend(file, "A", { expectedPriorBytes: 3 });
    await fsAppend(file, "B", { expectedPriorBytes: 4 });
    expect((await fsAppend(file, "B", { expectedPriorBytes: 4 })).ok).toBe(false);

    expect(readFileSync(file, "utf8")).toBe("abcAB");
  });

  it("keeps two distinct appends that carry identical content", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "twin.txt");
    writeFileSync(file, "abc");

    expect((await fsAppend(file, "X", { expectedPriorBytes: 3 })).ok).toBe(true);
    expect((await fsAppend(file, "X", { expectedPriorBytes: 4 })).ok).toBe(true);

    expect(readFileSync(file, "utf8")).toBe("abcXX");
  });

  it("prepends without treating an existing identical prefix as already applied", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "prepend.txt");
    writeFileSync(file, "Xbody");

    const result = await fsAppend(file, "X", {
      position: "start",
      expectedPriorBytes: 5,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("XXbody");
  });
});

