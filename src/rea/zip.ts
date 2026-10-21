import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, statfs } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

export interface ZipLimits {
  readonly entries: number;
  readonly entryBytes: number;
  readonly totalBytes: number;
}

export interface ZipExtractOptions {
  readonly strip?: number | undefined;
  readonly limits?: Partial<ZipLimits> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((extracted: number, total: number) => void) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export interface ZipExtractResult {
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

interface ZipEntry {
  readonly parts: readonly string[];
  readonly directory: boolean;
  readonly method: number;
  readonly crc: number;
  readonly compressedBytes: number;
  readonly bytes: number;
  readonly mode: number;
  readonly offset: number;
}

const DEFAULT_LIMITS: ZipLimits = { entries: 100_000, entryBytes: 2 * 1024 ** 3, totalBytes: 4 * 1024 ** 3 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const nativeCrc32 = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

function crcUpdate(previous: number, chunk: Uint8Array): number {
  if (typeof nativeCrc32 === "function") return nativeCrc32(chunk, previous);
  let value = ~previous >>> 0;
  for (let index = 0; index < chunk.length; index += 1) value = CRC_TABLE[(value ^ chunk[index]!) & 0xff]! ^ (value >>> 8);
  return ~value >>> 0;
}

function archiveError(message: string): Error {
  return new Error(`Unsafe or unsupported archive: ${message}`);
}

function entryParts(name: string, platform: NodeJS.Platform): { parts: string[]; directory: boolean } {
  if (name.length === 0 || name.length > 1_024 || /[\0-\x1f]/.test(name)) throw archiveError("invalid entry name");
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw archiveError(`absolute entry path ${name.slice(0, 80)}`);
  const directory = normalized.endsWith("/");
  const parts = (directory ? normalized.slice(0, -1) : normalized).split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.includes(":")) throw archiveError(`entry path ${name.slice(0, 80)}`);
    if (platform === "win32" && (WINDOWS_RESERVED.test(part) || /[. ]$/.test(part) || /[<>"|?*]/.test(part))) {
      throw archiveError(`entry name ${name.slice(0, 80)} is not valid on Windows`);
    }
  }
  return { parts, directory };
}

async function readAt(file: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) throw archiveError("truncated archive");
    filled += bytesRead;
  }
  return buffer;
}

interface ZipDirectory {
  readonly entries: readonly ZipEntry[];
  readonly offset: number;
}

async function readDirectory(
  file: Awaited<ReturnType<typeof open>>,
  size: number,
  limits: ZipLimits,
  platform: NodeJS.Platform,
): Promise<ZipDirectory> {
  const tailLength = Math.min(size, END_RECORD_BYTES + MAX_COMMENT_BYTES);
  const tail = await readAt(file, size - tailLength, tailLength);
  let end = -1;
  for (let index = tail.length - END_RECORD_BYTES; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === END_SIGNATURE && index + END_RECORD_BYTES + tail.readUInt16LE(index + 20) === tail.length) {
      end = index;
      break;
    }
  }
  if (end < 0) throw archiveError("end of central directory not found");
  const disk = tail.readUInt16LE(end + 4);
  const directoryDisk = tail.readUInt16LE(end + 6);
  const countOnDisk = tail.readUInt16LE(end + 8);
  const count = tail.readUInt16LE(end + 10);
  const directoryBytes = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (disk !== 0 || directoryDisk !== 0 || countOnDisk !== count) throw archiveError("multi-disk archives are not supported");
  if (count === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) throw archiveError("ZIP64 archives are not supported");
  if (count > limits.entries) throw archiveError(`more than ${limits.entries} entries`);
  if (directoryBytes > MAX_DIRECTORY_BYTES || directoryOffset + directoryBytes > size) throw archiveError("invalid central directory");
  const directory = await readAt(file, directoryOffset, directoryBytes);
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw archiveError("invalid central directory entry");
    const madeBy = directory.readUInt16LE(cursor + 4);
    const flags = directory.readUInt16LE(cursor + 8);
    const method = directory.readUInt16LE(cursor + 10);
    const crc = directory.readUInt32LE(cursor + 16);
    const compressedBytes = directory.readUInt32LE(cursor + 20);
    const bytes = directory.readUInt32LE(cursor + 24);
    const nameBytes = directory.readUInt16LE(cursor + 28);
    const extraBytes = directory.readUInt16LE(cursor + 30);
    const commentBytes = directory.readUInt16LE(cursor + 32);
    const attributes = directory.readUInt32LE(cursor + 38);
    const offset = directory.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (next > directory.length) throw archiveError("central directory entry exceeds its record");
    if (flags & 0x1 || flags & 0x40) throw archiveError("encrypted entries are not supported");
    if (compressedBytes === 0xffffffff || bytes === 0xffffffff || offset === 0xffffffff) throw archiveError("ZIP64 entries are not supported");
    const { parts, directory: isDirectory } = entryParts(directory.toString("utf8", cursor + 46, cursor + 46 + nameBytes), platform);
    const unixMode = madeBy >> 8 === 3 ? attributes >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) throw archiveError("symbolic links are not supported");
    if (!isDirectory && method !== 0 && method !== 8) throw archiveError(`compression method ${method}`);
    if (bytes > limits.entryBytes) throw archiveError("entry exceeds the size limit");
    entries.push({
      parts, directory: isDirectory, method, crc, compressedBytes, bytes,
      mode: unixMode & 0o111 ? 0o755 : 0o644, offset,
    });
    cursor = next;
  }
  return { entries, offset: directoryOffset };
}

function inside(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== "" && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

function guard(entry: ZipEntry, onBytes: (count: number) => void): Transform {
  let written = 0;
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      written += chunk.length;
      if (written > entry.bytes) {
        callback(archiveError("entry is larger than its declared size"));
        return;
      }
      crc = crcUpdate(crc, chunk);
      onBytes(chunk.length);
      callback(null, chunk);
    },
    flush(callback): void {
      if (written !== entry.bytes) callback(archiveError("entry is shorter than its declared size"));
      else if ((crc >>> 0) !== entry.crc) callback(archiveError("entry checksum mismatch"));
      else callback();
    },
  });
}

async function extractEntry(
  file: Awaited<ReturnType<typeof open>>,
  archive: string,
  entry: ZipEntry,
  target: string,
  directoryOffset: number,
  signal: AbortSignal | undefined,
  onBytes: (count: number) => void,
): Promise<void> {
  const local = await readAt(file, entry.offset, 30);
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw archiveError("invalid local file header");
  const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (start + entry.compressedBytes > directoryOffset) throw archiveError("entry data overlaps the central directory");
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  if (entry.compressedBytes === 0) {
    if (entry.bytes !== 0) throw archiveError("entry has no data");
    const empty = await open(target, "wx", entry.mode);
    await empty.close();
  } else {
    const source = createReadStream(archive, { start, end: start + entry.compressedBytes - 1 });
    const output = createWriteStream(target, { flags: "wx", mode: entry.mode });
    const check = guard(entry, onBytes);
    const options = signal ? { signal } : {};
    if (entry.method === 8) await pipeline(source, zlib.createInflateRaw(), check, output, options);
    else await pipeline(source, check, output, options);
  }
  if (process.platform !== "win32") await chmod(target, entry.mode);
}

export async function ensureFreeSpace(destination: string, needed: number): Promise<void> {
  try {
    const stats = await statfs(destination);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (available < needed + SPACE_MARGIN_BYTES) {
      const gigabytes = (needed + SPACE_MARGIN_BYTES) / 1024 ** 3;
      throw new Error(`Not enough free disk space: about ${gigabytes.toFixed(1)} GB is needed in ${destination}`);
    }
  } catch (error) {
    if ((error as Error).message.startsWith("Not enough free disk space")) throw error;
  }
}

export async function extractZip(archive: string, destination: string, options: ZipExtractOptions = {}): Promise<ZipExtractResult> {
  const limits: ZipLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const platform = options.platform ?? process.platform;
  const strip = options.strip ?? 0;
  const root = resolve(destination);
  const file = await open(archive, "r");
  try {
    const { size } = await file.stat();
    const { entries, offset: directoryOffset } = await readDirectory(file, size, limits, platform);
    const planned: Array<{ entry: ZipEntry; path: string }> = [];
    const seen = new Set<string>();
    let total = 0;
    for (const entry of entries) {
      if (entry.parts.length <= strip) {
        if (!entry.directory) throw archiveError("file outside the stripped archive root");
        continue;
      }
      const parts = entry.parts.slice(strip);
      const path = resolve(root, ...parts);
      if (!inside(root, path)) throw archiveError("entry escapes the destination");
      const key = (platform === "win32" || platform === "darwin" ? path.toLowerCase() : path);
      if (seen.has(key)) throw archiveError(`duplicate entry ${parts.join("/").slice(0, 80)}`);
      seen.add(key);
      if (!entry.directory) total += entry.bytes;
      if (total > limits.totalBytes) throw archiveError("archive exceeds the total size limit");
      planned.push({ entry: { ...entry, parts }, path });
    }
    await mkdir(root, { recursive: true, mode: 0o755 });
    await ensureFreeSpace(root, total);
    let extracted = 0;
    let files = 0;
    let directories = 0;
    for (const { entry, path } of planned) {
      options.signal?.throwIfAborted();
      if (entry.directory) {
        await mkdir(path, { recursive: true, mode: 0o755 });
        directories += 1;
        continue;
      }
      await extractEntry(file, archive, entry, path, directoryOffset, options.signal, (count) => {
        extracted += count;
      });
      files += 1;
      options.onProgress?.(extracted, total);
    }
    return { files, directories, bytes: extracted };
  } finally {
    await file.close();
  }
}
