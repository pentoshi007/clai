import { deflateRawSync } from "node:zlib";

interface ZipFixtureEntry {
  readonly name: string;
  readonly body: string | Buffer;
  readonly stored?: boolean;
  readonly descriptor?: boolean;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipFixture(entries: readonly ZipFixtureEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = Buffer.from(entry.body);
    const data = entry.stored ? body : deflateRawSync(body);
    const header = Buffer.alloc(30);
    const index = Buffer.alloc(46);
    const crc = crc32(body);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(entry.descriptor ? 8 : 0, 6);
    header.writeUInt16LE(entry.stored ? 0 : 8, 8);
    header.writeUInt32LE(entry.descriptor ? 0 : crc, 14);
    header.writeUInt32LE(entry.descriptor ? 0 : data.length, 18);
    header.writeUInt32LE(entry.descriptor ? 0 : body.length, 22);
    header.writeUInt16LE(name.length, 26);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(entry.descriptor ? 8 : 0, 8);
    index.writeUInt16LE(entry.stored ? 0 : 8, 10);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(body.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(body.length, 12);
    }
    local.push(header, name, data, descriptor);
    central.push(index, name);
    offset += header.length + name.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
