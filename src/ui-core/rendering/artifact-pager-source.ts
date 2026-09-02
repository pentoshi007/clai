import { open, stat } from "node:fs/promises";

export const DEFAULT_ARTIFACT_PAGE_BYTES = 64 * 1024;
export const MAX_FULL_ARTIFACT_EXPORT_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const SEARCH_CHUNK_BYTES = 64 * 1024;

export interface ArtifactPage {
  readonly body: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly totalBytes: number;
  readonly pageNumber: number;
  readonly pageCount: number;
}

export interface ArtifactPagerSource {
  readonly path: string;
  readonly pageBytes: number;
  readPage(offset: number): Promise<ArtifactPage>;
  search(query: string, fromOffset?: number, reverse?: boolean): Promise<ArtifactPage | undefined>;
  readAll(): Promise<string>;
  dispose(): void;
  readTail?(): Promise<ArtifactPage>;
  watch?(onChange: () => void): () => void;
  isGrowing?(): boolean;
}

export function createArtifactPagerSource(
  path: string,
  pageBytes = DEFAULT_ARTIFACT_PAGE_BYTES,
): ArtifactPagerSource {
  const boundedPageBytes = Math.max(1024, Math.min(MAX_PAGE_BYTES, Math.floor(pageBytes)));
  let disposed = false;
  const assertOpen = (): void => {
    if (disposed) throw new Error("artifact pager source is disposed");
  };

  const readRange = async (offset: number, bytes: number): Promise<{ buffer: Buffer; total: number }> => {
    assertOpen();
    const info = await stat(path);
    const start = Math.max(0, Math.min(Math.floor(offset), info.size));
    const length = Math.max(0, Math.min(bytes, info.size - start));
    const handle = await open(path, "r");
    const buffer = Buffer.alloc(length);
    try {
      if (length > 0) await handle.read(buffer, 0, length, start);
    } finally {
      await handle.close();
    }
    return { buffer, total: info.size };
  };

  const readPage = async (offset: number): Promise<ArtifactPage> => {
    const requested = Math.max(0, Math.floor(offset));
    const { buffer, total } = await readRange(requested, boundedPageBytes + 4);
    let start = 0;
    while (start < Math.min(4, buffer.length) && (buffer[start]! & 0xc0) === 0x80) start += 1;
    let end = Math.min(buffer.length, boundedPageBytes);
    while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end += 1;
    const visible = buffer.subarray(start, end);
    const pageCount = Math.max(1, Math.ceil(total / boundedPageBytes));
    return {
      body: new TextDecoder("utf-8", { fatal: false }).decode(visible),
      offset: requested,
      nextOffset: Math.min(total, requested + boundedPageBytes),
      totalBytes: total,
      pageNumber: Math.min(pageCount, Math.floor(requested / boundedPageBytes) + 1),
      pageCount,
    };
  };

  const readTail = async (): Promise<ArtifactPage> => {
    assertOpen();
    const info = await stat(path);
    return readPage(Math.max(0, info.size - boundedPageBytes));
  };

  return {
    path,
    pageBytes: boundedPageBytes,
    readPage,
    readTail,
    async search(query, fromOffset = 0, reverse = false) {
      assertOpen();
      const needle = Buffer.from(query, "utf8");
      if (needle.length === 0) return readPage(fromOffset);
      const info = await stat(path);
      if (!reverse) {
        let offset = Math.max(0, Math.min(fromOffset, info.size));
        let carry = Buffer.alloc(0);
        while (offset < info.size) {
          const { buffer } = await readRange(offset, SEARCH_CHUNK_BYTES);
          const haystack = Buffer.concat([carry, buffer]);
          const index = haystack.indexOf(needle);
          if (index >= 0) {
            const absolute = offset - carry.length + index;
            return readPage(Math.max(0, absolute - Math.floor(boundedPageBytes / 2)));
          }
          if (buffer.length === 0) break;
          carry = haystack.subarray(Math.max(0, haystack.length - needle.length + 1));
          offset += buffer.length;
        }
        return undefined;
      }
      let end = Math.max(0, Math.min(fromOffset || info.size, info.size));
      let carry = Buffer.alloc(0);
      while (end > 0) {
        const start = Math.max(0, end - SEARCH_CHUNK_BYTES);
        const { buffer } = await readRange(start, end - start);
        const haystack = Buffer.concat([buffer, carry]);
        const index = haystack.lastIndexOf(needle);
        if (index >= 0) return readPage(Math.max(0, start + index - Math.floor(boundedPageBytes / 2)));
        carry = haystack.subarray(0, Math.min(needle.length - 1, haystack.length));
        end = start;
      }
      return undefined;
    },
    async readAll() {
      assertOpen();
      const info = await stat(path);
      if (info.size > MAX_FULL_ARTIFACT_EXPORT_BYTES) {
        throw new Error(
          `artifact is ${info.size.toLocaleString()} bytes; full copy/export is limited to ${MAX_FULL_ARTIFACT_EXPORT_BYTES.toLocaleString()} bytes. Page it in the UI or open ${path} directly.`,
        );
      }
      const { buffer } = await readRange(0, info.size);
      return buffer.toString("utf8");
    },
    dispose() { disposed = true; },
  };
}

export function createTextPagerSource(
  text: string,
  path = "memory://pager",
  pageBytes = DEFAULT_ARTIFACT_PAGE_BYTES,
): ArtifactPagerSource {
  const boundedPageBytes = Math.max(1024, Math.min(MAX_PAGE_BYTES, Math.floor(pageBytes)));
  let data = Buffer.from(text, "utf8");
  let disposed = false;
  const assertOpen = (): void => {
    if (disposed) throw new Error("artifact pager source is disposed");
  };
  const readPage = async (offset: number): Promise<ArtifactPage> => {
    assertOpen();
    const total = data.length;
    const requested = Math.max(0, Math.min(Math.floor(offset), total));
    let start = requested;
    while (start < total && (data[start]! & 0xc0) === 0x80) start += 1;
    let end = Math.min(total, requested + boundedPageBytes);
    while (end < total && (data[end]! & 0xc0) === 0x80) end += 1;
    const pageCount = Math.max(1, Math.ceil(total / boundedPageBytes));
    return {
      body: data.subarray(start, end).toString("utf8"),
      offset: requested,
      nextOffset: Math.min(total, requested + boundedPageBytes),
      totalBytes: total,
      pageNumber: Math.min(pageCount, Math.floor(requested / boundedPageBytes) + 1),
      pageCount,
    };
  };
  return {
    path,
    pageBytes: boundedPageBytes,
    readPage,
    readTail: async () => {
      assertOpen();
      return readPage(Math.max(0, data.length - boundedPageBytes));
    },
    async search(query, fromOffset = 0, reverse = false) {
      assertOpen();
      const needle = Buffer.from(query, "utf8");
      if (needle.length === 0) return readPage(fromOffset);
      const requested = Math.max(0, Math.min(Math.floor(fromOffset), data.length));
      const from = reverse && requested === 0 ? data.length : requested;
      const index = reverse
        ? data.lastIndexOf(needle, Math.max(0, from - 1))
        : data.indexOf(needle, from);
      return index < 0
        ? undefined
        : readPage(Math.max(0, index - Math.floor(boundedPageBytes / 2)));
    },
    async readAll() {
      assertOpen();
      if (data.length > MAX_FULL_ARTIFACT_EXPORT_BYTES) {
        throw new Error(
          `artifact is ${data.length.toLocaleString()} bytes; full copy/export is limited to ${MAX_FULL_ARTIFACT_EXPORT_BYTES.toLocaleString()} bytes. Page it in the UI instead.`,
        );
      }
      return data.toString("utf8");
    },
    dispose() {
      disposed = true;
      data = Buffer.alloc(0);
    },
  };
}
