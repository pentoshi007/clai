import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractVerifiedZipBinary } from "../src/tools/rtk/archive.js";
import { zipFixture } from "./helpers/zip-fixture.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rtk zip 界 ' ")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const payload = Buffer.from("executable fixture\0界🙂");
function fixture(): Buffer { return zipFixture([{ name: "rtk.exe", body: payload }]); }
function directoryOffset(data: Buffer): number { return data.readUInt32LE(data.length - 6); }

describe("verified RTK ZIP extraction", () => {
  it.each([{ stored: true }, { stored: false }, { descriptor: true }])("extracts only the executable using the runtime, without external archive tools: %j", async (options) => {
    const zip = zipFixture([{ name: "LICENSE", body: "ignored" }, { name: "rtk.exe", body: payload, ...options }]);
    const path = await extractVerifiedZipBinary(zip, root, "rtk.exe");
    expect(await readFile(path)).toEqual(payload);
    expect(await readdir(root)).toEqual(["rtk.exe"]);
  });

  it("supports an executable nested under a release directory", async () => {
    const zip = zipFixture([{ name: "rtk-release/bin/rtk.exe", body: payload }]);
    expect(await readFile(await extractVerifiedZipBinary(zip, root, "rtk.exe"))).toEqual(payload);
  });

  it("does not overwrite an existing staged executable", async () => {
    await writeFile(join(root, "rtk.exe"), "preserved");
    await expect(extractVerifiedZipBinary(fixture(), root, "rtk.exe")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, "rtk.exe"), "utf8")).toBe("preserved");
  });

  it.each(["../rtk.exe", "/rtk.exe", "C:/rtk.exe", "..\\rtk.exe"])("rejects unsafe binary paths: %s", async (name) => {
    await expect(extractVerifiedZipBinary(zipFixture([{ name, body: payload }]), root, "rtk.exe")).rejects.toThrow("unsafe ZIP binary path");
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects duplicate executable entries and missing binaries", async () => {
    const duplicate = zipFixture([{ name: "rtk.exe", body: payload }, { name: "nested/rtk.exe", body: payload }]);
    await expect(extractVerifiedZipBinary(duplicate, root, "rtk.exe")).rejects.toThrow("multiple rtk.exe");
    await expect(extractVerifiedZipBinary(zipFixture([{ name: "other.exe", body: payload }]), root, "rtk.exe")).rejects.toThrow("not found");
  });

  it.each(["../rtk.exe", ".", ".."])("rejects unsafe destination names: %s", async (name) => {
    await expect(extractVerifiedZipBinary(fixture(), root, name)).rejects.toThrow("invalid binary filename");
  });

  it("rejects incomplete archives, invalid directory offsets and ZIP64 entry counts", async () => {
    await expect(extractVerifiedZipBinary(Buffer.alloc(4), root, "rtk.exe")).rejects.toThrow("ZIP");
    await expect(extractVerifiedZipBinary(fixture().subarray(0, -4), root, "rtk.exe")).rejects.toThrow("ZIP");
    const offset = fixture();
    offset.writeUInt32LE(0x7fffffff, offset.length - 6);
    await expect(extractVerifiedZipBinary(offset, root, "rtk.exe")).rejects.toThrow("ZIP");
    const zip64 = fixture();
    zip64.writeUInt16LE(0xffff, zip64.length - 14);
    zip64.writeUInt16LE(0xffff, zip64.length - 12);
    await expect(extractVerifiedZipBinary(zip64, root, "rtk.exe")).rejects.toThrow("ZIP64");
  });

  it("rejects encryption and symbolic-link binary entries", async () => {
    const encrypted = fixture();
    encrypted.writeUInt16LE(1, directoryOffset(encrypted) + 8);
    await expect(extractVerifiedZipBinary(encrypted, root, "rtk.exe")).rejects.toThrow("encrypted");
    const symlink = fixture();
    symlink.writeUInt32LE((0xa1ff << 16) >>> 0, directoryOffset(symlink) + 38);
    await expect(extractVerifiedZipBinary(symlink, root, "rtk.exe")).rejects.toThrow("symbolic-link");
  });

  it("rejects unsupported compression and inconsistent local headers", async () => {
    const compression = fixture();
    compression.writeUInt16LE(12, 8);
    compression.writeUInt16LE(12, directoryOffset(compression) + 10);
    await expect(extractVerifiedZipBinary(compression, root, "rtk.exe")).rejects.toThrow("compression method");
    const header = fixture();
    header.writeUInt16LE(0, 8);
    await expect(extractVerifiedZipBinary(header, root, "rtk.exe")).rejects.toThrow("does not match");
    const name = fixture();
    name.write("bad.exe", 30);
    await expect(extractVerifiedZipBinary(name, root, "rtk.exe")).rejects.toThrow("offset or name");
  });

  it("bounds decompression and rejects a false expanded size", async () => {
    const huge = fixture();
    huge.writeUInt32LE(129 * 1024 * 1024, directoryOffset(huge) + 24);
    await expect(extractVerifiedZipBinary(huge, root, "rtk.exe")).rejects.toThrow("size limit");
    const size = fixture();
    size.writeUInt32LE(1, directoryOffset(size) + 24);
    await expect(extractVerifiedZipBinary(size, root, "rtk.exe")).rejects.toThrow("size does not match");
    expect(await readdir(root)).toEqual([]);
  });
});
