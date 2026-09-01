import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  writeFile,
  stat,
  lstat,
  readFile,
  readdir,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  fsEdit,
  fsAppend,
  fsDelete,
  fsReplaceLines,
  fsWrite,
} from "../../src/tools/fs.js";

let dir: string;
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clai-atomic-"));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
});

describe("TOOL-001 atomic writes preserve mode and are race-safe", () => {
  it("keeps an executable file executable after fs.edit", async () => {
    const file = join(dir, "run.sh");
    await writeFile(file, "#!/bin/sh\necho old\n", "utf8");
    await chmod(file, 0o755);
    const result = await fsEdit(file, "old", "new", 1, { confirmed: true });
    expect(result.ok).toBe(true);
    const st = await stat(file);
    if (platform() !== "win32") {
      expect(st.mode & 0o777).toBe(0o755);
    }
    expect(await readFile(file, "utf8")).toContain("echo new");
  });

  it("keeps a private file private after fs.append", async () => {
    const file = join(dir, "secret.env");
    await writeFile(file, "A=1\n", "utf8");
    await chmod(file, 0o600);
    const result = await fsAppend(file, "B=2\n", { confirmed: true });
    expect(result.ok).toBe(true);
    const st = await stat(file);
    if (platform() !== "win32") {
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it("preserves mode through fs.replaceLines", async () => {
    const file = join(dir, "tool.sh");
    await writeFile(file, "a\nb\nc\n", "utf8");
    await chmod(file, 0o750);
    const result = await fsReplaceLines(file, 2, 2, "B", { confirmed: true });
    expect(result.ok).toBe(true);
    if (platform() !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o750);
    }
  });

  it("concurrent edits of the same file do not share a temp path", async () => {
    const file = join(dir, "notes.md");
    await writeFile(file, "x\n".repeat(50), "utf8");
    const results = await Promise.all([
      fsAppend(file, "one\n", { confirmed: true }),
      fsAppend(file, "two\n", { confirmed: true }),
      fsAppend(file, "three\n", { confirmed: true }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const leftovers = (await readdir(dir)).filter((name) =>
      name.includes(".clai-"),
    );
    expect(leftovers).toEqual([]);
    const text = await readFile(file, "utf8");
    for (const chunk of ["one\n", "two\n", "three\n"]) {
      expect(text).toContain(chunk);
    }
  });

  it("serializes concurrent appends that arrive through a symlink alias", async () => {
    if (platform() === "win32") return;
    const target = join(dir, "shared.log");
    const alias = join(dir, "shared-alias.log");
    await writeFile(target, "", "utf8");
    await symlink(target, alias);

    const results = await Promise.all([
      fsAppend(target, "direct\n", { confirmed: true }),
      fsAppend(alias, "alias\n", { confirmed: true }),
      fsAppend(target, "third\n", { confirmed: true }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const text = await readFile(target, "utf8");
    for (const chunk of ["direct\n", "alias\n", "third\n"]) {
      expect(text).toContain(chunk);
    }
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("writes through a leaf symlink instead of replacing the link", async () => {
    if (platform() === "win32") return;
    const target = join(dir, "target.conf");
    const alias = join(dir, "alias.conf");
    await writeFile(target, "old\n", "utf8");
    await chmod(target, 0o640);
    await symlink(target, alias);

    expect((await fsWrite(alias, "new\n", { confirmed: true })).ok).toBe(true);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect((await stat(target)).mode & 0o777).toBe(0o640);

    expect((await fsAppend(alias, "more\n", { confirmed: true })).ok).toBe(true);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new\nmore\n");
  });

  it("creates a file below a symlinked directory inside the real directory", async () => {
    if (platform() === "win32") return;
    const real = join(dir, "real-dir");
    const link = join(dir, "link-dir");
    await fsWrite(join(real, "seed.txt"), "seed", { confirmed: true });
    await symlink(real, link);

    const result = await fsWrite(join(link, "made.txt"), "body", {
      confirmed: true,
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(real, "made.txt"), "utf8")).toBe("body");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("deletes a symlink without following it to the target", async () => {
    if (platform() === "win32") return;
    const target = join(dir, "keep.txt");
    const alias = join(dir, "drop.txt");
    await writeFile(target, "keep\n", "utf8");
    await symlink(target, alias);

    const result = await fsDelete(alias, false, { confirmed: true });
    expect(result.ok).toBe(true);
    await expect(lstat(alias)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("keep\n");
  });
});
