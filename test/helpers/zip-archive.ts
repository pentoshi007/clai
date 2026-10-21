import { deflateRawSync } from "node:zlib";

export interface ArchiveEntry {
  readonly name: string;
  readonly body?: string | Buffer;
  readonly mode?: number;
  readonly stored?: boolean;
  readonly method?: number;
  readonly flags?: number;
  readonly crc?: number;
  readonly declared?: number;
  readonly symlink?: boolean;
}

export interface ArchiveOptions {
  readonly entryCount?: number;
  readonly comment?: string;
  readonly truncate?: number;
}

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipArchive(entries: readonly ArchiveEntry[], options: ArchiveOptions = {}): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const directory = entry.name.endsWith("/");
    const body = Buffer.from(entry.body ?? "");
    const method = entry.method ?? (entry.stored || directory || body.length === 0 ? 0 : 8);
    const data = method === 8 ? deflateRawSync(body) : body;
    const crc = entry.crc ?? crc32(body);
    const declared = entry.declared ?? body.length;
    const type = entry.symlink ? 0o120000 : directory ? 0o040000 : 0o100000;
    const mode = (type | (entry.mode ?? (directory ? 0o755 : 0o644))) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(declared, 22);
    header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE((3 << 8) | 20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(entry.flags ?? 0, 8);
    index.writeUInt16LE(method, 10);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(declared, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE((mode << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(index, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const comment = Buffer.from(options.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(options.entryCount ?? entries.length, 8);
  end.writeUInt16LE(options.entryCount ?? entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  const archive = Buffer.concat([...local, directory, end, comment]);
  return options.truncate === undefined ? archive : archive.subarray(0, options.truncate);
}
