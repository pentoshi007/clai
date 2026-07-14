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
    expect(result.output).toContain("Appended text to the end");
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
    expect(result.output).toContain("Appended text to the start");
    const content = readFileSync(file, "utf8");
    expect(content).toBe("line 1\nline 2\n");
  });

  it("creates the file if it does not exist", async () => {
    const dir = makeTempDir("fsappend");
    dirs.push(dir);
    const file = join(dir, "newfile.txt");

    const result = await fsAppend(file, "hello new file\n");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Created and wrote to");
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
});
