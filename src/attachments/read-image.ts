import { open } from "node:fs/promises";

export async function readImageBytes(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0) throw new Error("image is not a non-empty regular file");
    if (before.size > maxBytes) throw new Error("image exceeds the model input byte limit");
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, Math.min(262_144, buffer.length - offset), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    signal?.throwIfAborted();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("image bytes changed while being read; try again");
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
