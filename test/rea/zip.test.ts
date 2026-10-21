import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFreeSpace, extractZip } from "../../src/rea/zip.js";
import { zipArchive, type ArchiveEntry } from "../helpers/zip-archive.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clai-zip-"));
  directories.push(path);
  return path;
}

async function archiveOf(entries: readonly ArchiveEntry[], options?: Parameters<typeof zipArchive>[1]): Promise<{ archive: string; output: string }> {
  const root = await workspace();
  const archive = join(root, "fixture.zip");
  await writeFile(archive, zipArchive(entries, options));
  return { archive, output: join(root, "out") };
}

async function tree(root: string, prefix = ""): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(`${path}/`, ...await tree(root, path));
    else names.push(path);
  }
  return names.sort();
}

describe("zip extraction", () => {
  it("extracts a nested tree below a stripped root and reports what it wrote", async () => {
    const { archive, output } = await archiveOf([
      { name: "root/" },
      { name: "root/bin/" },
      { name: "root/bin/tool", body: "#!/bin/sh\n", mode: 0o755 },
      { name: "root/docs/readme.txt", body: "hello" },
      { name: "root/docs/empty.txt" },
      { name: "root/stored.txt", body: "kept as is", stored: true },
    ]);
    const progress: number[] = [];
    const result = await extractZip(archive, output, { strip: 1, onProgress: (done) => progress.push(done) });
    expect(await tree(output)).toEqual(["bin/", "bin/tool", "docs/", "docs/empty.txt", "docs/readme.txt", "stored.txt"]);
    expect(await readFile(join(output, "docs", "readme.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(output, "stored.txt"), "utf8")).toBe("kept as is");
    expect((await stat(join(output, "docs", "empty.txt"))).size).toBe(0);
    expect(result).toMatchObject({ files: 4 });
    expect(progress.at(-1)).toBe(result.bytes);
  });

  it.skipIf(process.platform === "win32")("keeps executable bits and strips unsafe ones", async () => {
    const { archive, output } = await archiveOf([
      { name: "run.sh", body: "x", mode: 0o4755 },
      { name: "plain.txt", body: "x", mode: 0o666 },
    ]);
    await extractZip(archive, output);
    expect((await stat(join(output, "run.sh"))).mode & 0o7777).toBe(0o755);
    expect((await stat(join(output, "plain.txt"))).mode & 0o7777).toBe(0o644);
  });

  it("streams large entries without holding them in memory", async () => {
    const body = randomBytes(6 * 1024 * 1024);
    const { archive, output } = await archiveOf([{ name: "big.bin", body }, { name: "big-stored.bin", body, stored: true }]);
    const result = await extractZip(archive, output);
    expect(result.bytes).toBe(body.length * 2);
    expect((await readFile(join(output, "big.bin"))).equals(body)).toBe(true);
    expect((await readFile(join(output, "big-stored.bin"))).equals(body)).toBe(true);
  });

  it.each([
    ["parent traversal", "../escape.txt"],
    ["nested traversal", "a/../../escape.txt"],
    ["backslash traversal", "a\\..\\..\\escape.txt"],
    ["absolute path", "/etc/escape.txt"],
    ["drive letter", "C:\\escape.txt"],
    ["alternate stream", "a/file.txt:stream"],
    ["empty component", "a//b.txt"],
    ["control character", "a/b\u0001.txt"],
  ])("refuses %s", async (_label, name) => {
    const { archive, output } = await archiveOf([{ name: "safe.txt", body: "x" }, { name, body: "x" }]);
    await expect(extractZip(archive, output)).rejects.toThrow(/Unsafe or unsupported archive/);
    expect(await readdir(join(archive, "..")).then((names) => names.includes("escape.txt"))).toBe(false);
  });

  it("refuses names Windows cannot represent when extracting there", async () => {
    for (const name of ["con.txt", "dir/NUL", "trailing.", "bad<name>.txt"]) {
      const { archive, output } = await archiveOf([{ name, body: "x" }]);
      await expect(extractZip(archive, output, { platform: "win32" })).rejects.toThrow(/not valid on Windows/);
    }
  });

  it("refuses symbolic links, encrypted entries and unknown compression", async () => {
    for (const entry of [
      { name: "link", body: "target", symlink: true },
      { name: "secret.txt", body: "x", flags: 1 },
      { name: "weird.txt", body: "x", method: 12 },
    ]) {
      const { archive, output } = await archiveOf([entry]);
      await expect(extractZip(archive, output)).rejects.toThrow(/Unsafe or unsupported archive/);
    }
  });

  it("detects corrupt, inflated and shortened entries", async () => {
    const cases: Array<[ArchiveEntry, RegExp]> = [
      [{ name: "a.txt", body: "payload", crc: 12345 }, /checksum mismatch/],
      [{ name: "a.txt", body: "payload payload", declared: 3 }, /larger than its declared size/],
      [{ name: "a.txt", body: "payload", declared: 99 }, /shorter than its declared size/],
    ];
    for (const [entry, pattern] of cases) {
      const { archive, output } = await archiveOf([entry]);
      await expect(extractZip(archive, output)).rejects.toThrow(pattern);
    }
  });

  it("refuses truncated archives and a missing central directory", async () => {
    const whole = zipArchive([{ name: "a.txt", body: "x".repeat(2000) }]);
    const root = await workspace();
    for (const [name, bytes] of [["cut.zip", whole.subarray(0, whole.length - 30)], ["junk.zip", Buffer.from("not a zip file at all")]] as const) {
      await writeFile(join(root, name), bytes);
      await expect(extractZip(join(root, name), join(root, "out"))).rejects.toThrow(/Unsafe or unsupported archive/);
    }
  });

  it("refuses ZIP64 markers, duplicate paths and file entries outside the stripped root", async () => {
    const zip64 = await archiveOf([{ name: "a.txt", body: "x" }], { entryCount: 0xffff });
    await expect(extractZip(zip64.archive, zip64.output)).rejects.toThrow(/ZIP64/);
    const duplicate = await archiveOf([{ name: "a.txt", body: "1" }, { name: "A.TXT", body: "2" }]);
    await expect(extractZip(duplicate.archive, duplicate.output, { platform: "win32" })).rejects.toThrow(/duplicate entry/);
    const loose = await archiveOf([{ name: "root/", }, { name: "loose.txt", body: "x" }]);
    await expect(extractZip(loose.archive, loose.output, { strip: 1 })).rejects.toThrow(/outside the stripped archive root/);
  });

  it("enforces entry, size and entry-count limits before writing anything", async () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({ name: `f${index}.txt`, body: "x".repeat(100) }));
    const many = await archiveOf(entries);
    await expect(extractZip(many.archive, many.output, { limits: { entries: 4 } })).rejects.toThrow(/more than 4 entries/);
    await expect(extractZip(many.archive, many.output, { limits: { totalBytes: 300 } })).rejects.toThrow(/total size limit/);
    await expect(extractZip(many.archive, many.output, { limits: { entryBytes: 50 } })).rejects.toThrow(/size limit/);
    await expect(stat(many.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops promptly when cancelled", async () => {
    const { archive, output } = await archiveOf([{ name: "a.txt", body: "x" }, { name: "b.txt", body: "y" }]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by the user"));
    await expect(extractZip(archive, output, { signal: controller.signal })).rejects.toThrow("cancelled by the user");
  });

  it("checks free disk space before a large install", async () => {
    const root = await workspace();
    await expect(ensureFreeSpace(root, 1024)).resolves.toBeUndefined();
    await expect(ensureFreeSpace(root, 1e18)).rejects.toThrow(/Not enough free disk space: about .* GB is needed/);
    await expect(ensureFreeSpace(join(root, "does-not-exist"), 1e18)).resolves.toBeUndefined();
  });

  it("finds the end record behind an archive comment", async () => {
    const { archive, output } = await archiveOf([{ name: "a.txt", body: "kept" }], { comment: "built by a release tool" });
    await extractZip(archive, output);
    expect(await readFile(join(output, "a.txt"), "utf8")).toBe("kept");
  });
});
