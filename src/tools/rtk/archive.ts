import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4_096;

interface ZipDirectory {
  readonly offset: number;
  readonly size: number;
  readonly entries: number;
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly offset: number;
}

function checkRange(data: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.length) {
    throw new Error("invalid or truncated ZIP archive");
  }
}

function zipDirectory(data: Buffer): ZipDirectory {
  for (let end = data.length - 22; end >= Math.max(0, data.length - 65_557); end -= 1) {
    if (data.readUInt32LE(end) !== 0x06054b50 || end + 22 + data.readUInt16LE(end + 20) !== data.length) continue;
    const entries = data.readUInt16LE(end + 10);
    if (data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0 || data.readUInt16LE(end + 8) !== entries) {
      throw new Error("multi-disk ZIP archives are not supported");
    }
    if (entries > MAX_ZIP_ENTRIES) throw new Error("ZIP archive has too many entries or requires ZIP64");
    const size = data.readUInt32LE(end + 12);
    const offset = data.readUInt32LE(end + 16);
    checkRange(data, offset, size);
    if (offset + size > end) throw new Error("invalid ZIP directory offset");
    return { entries, size, offset };
  }
  throw new Error("invalid or incomplete ZIP directory");
}

function binaryEntry(data: Buffer, directory: ZipDirectory, binaryName: string): ZipEntry {
  let cursor = directory.offset;
  let result: ZipEntry | undefined;
  const end = cursor + directory.size;
  for (let index = 0; index < directory.entries; index += 1) {
    checkRange(data, cursor, 46);
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP entry");
    const nameLength = data.readUInt16LE(cursor + 28);
    const entryLength = 46 + nameLength + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
    if (cursor + entryLength > end) throw new Error("ZIP entry exceeds its directory");
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const parts = name.replace(/\\/g, "/").split("/");
    if (parts.at(-1)?.toLowerCase() === binaryName.toLowerCase()) {
      if (result) throw new Error(`ZIP archive contains multiple ${binaryName} binaries`);
      if (parts.some((part) => !part || part === "." || part === ".." || /[:\0]/.test(part))) {
        throw new Error("unsafe ZIP binary path");
      }
      const flags = data.readUInt16LE(cursor + 8);
      const mode = data.readUInt32LE(cursor + 38) >>> 16;
      if (flags & 1 || (mode & 0xf000) === 0xa000) throw new Error("encrypted or symbolic-link ZIP binaries are not supported");
      result = {
        name, flags, method: data.readUInt16LE(cursor + 10),
        compressedSize: data.readUInt32LE(cursor + 20), size: data.readUInt32LE(cursor + 24),
        offset: data.readUInt32LE(cursor + 42),
      };
    }
    cursor += entryLength;
  }
  if (!result) throw new Error(`${binaryName} was not found in the ZIP archive`);
  return result;
}

async function binaryBytes(data: Buffer, entry: ZipEntry, directory: ZipDirectory): Promise<Buffer> {
  if (entry.size < 1 || entry.size > MAX_BINARY_BYTES || entry.compressedSize > MAX_BINARY_BYTES) {
    throw new Error("ZIP binary exceeds the supported size limit");
  }
  checkRange(data, entry.offset, 30);
  if (data.readUInt32LE(entry.offset) !== 0x04034b50 || data.readUInt16LE(entry.offset + 8) !== entry.method || data.readUInt16LE(entry.offset + 6) !== entry.flags) {
    throw new Error("ZIP local entry does not match its directory");
  }
  const nameLength = data.readUInt16LE(entry.offset + 26);
  const start = entry.offset + 30 + nameLength + data.readUInt16LE(entry.offset + 28);
  checkRange(data, start, entry.compressedSize);
  if (start + entry.compressedSize > directory.offset || data.subarray(entry.offset + 30, entry.offset + 30 + nameLength).toString("utf8") !== entry.name) {
    throw new Error("invalid ZIP binary data offset or name");
  }
  const compressed = data.subarray(start, start + entry.compressedSize);
  let bytes: Buffer;
  if (entry.method === 0) bytes = compressed;
  else if (entry.method === 8) bytes = await inflate(compressed, { maxOutputLength: MAX_BINARY_BYTES });
  else throw new Error(`unsupported ZIP compression method ${entry.method}`);
  if (bytes.length !== entry.size) throw new Error("ZIP binary size does not match its directory");
  return bytes;
}

export async function extractVerifiedZipBinary(data: Buffer, directory: string, name: string): Promise<string> {
  if (!/^[a-z0-9._-]+$/i.test(name) || name === "." || name === "..") throw new Error("invalid binary filename");
  const index = zipDirectory(data);
  const bytes = await binaryBytes(data, binaryEntry(data, index, name), index);
  const path = join(directory, name);
  await writeFile(path, bytes, { flag: "wx", mode: 0o700 });
  return path;
}
