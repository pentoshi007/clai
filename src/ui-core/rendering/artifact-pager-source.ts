import { open, stat } from "node:fs/promises";
import type { PagerBodyRegions, PagerCommandTone } from "./pager-regions.js";

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
  readonly layout?: "continuous" | undefined;
  readonly quotePrefix?: string | undefined;
  readonly literalQuotes?: boolean | undefined;
  readonly lineChangeColors?: boolean | undefined;
  readonly diffLines?: boolean | undefined;
  readPage(offset: number): Promise<ArtifactPage>;
  search(query: string, fromOffset?: number, reverse?: boolean): Promise<ArtifactPage | undefined>;
  readAll(): Promise<string>;
  dispose(): void;
  readTail?(): Promise<ArtifactPage>;
  watch?(onChange: () => void): () => void;
  isGrowing?(): boolean;
  commandTone?(): PagerCommandTone;
  commandText?(): string | undefined;
  regions?(): PagerBodyRegions | undefined;
}

export interface ArtifactByteView {
  readonly size: number;
  read(start: number, length: number): Promise<Buffer>;
}

const EMPTY_VIEW: ArtifactByteView = { size: 0, read: async () => Buffer.alloc(0) };

export async function readArtifactFile(path: string, allowMissing = false): Promise<ArtifactByteView> {
  try {
    const { size } = await stat(path);
    return {
      size,
      async read(start, length) {
        const bytes = Math.max(0, Math.min(length, size - start));
        if (bytes === 0) return Buffer.alloc(0);
        const handle = await open(path, "r");
        try {
          const buffer = Buffer.allocUnsafe(bytes);
          const { bytesRead } = await handle.read(buffer, 0, bytes, start);
          return buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      },
    };
  } catch (error) {
    if (allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT") return EMPTY_VIEW;
    throw error;
  }
}

export async function withoutArtifactPrefix(view: ArtifactByteView, prefix: Buffer, waitForPrefix = false): Promise<ArtifactByteView> {
  const head = await view.read(0, prefix.length);
  if (waitForPrefix && head.length < prefix.length && head.equals(prefix.subarray(0, head.length))) return EMPTY_VIEW;
  if (!head.equals(prefix)) return view;
  return {
    size: view.size - prefix.length,
    read: (start, length) => view.read(start + prefix.length, length),
  };
}

export function createArtifactPagerSource(
  path: string,
  pageBytes = DEFAULT_ARTIFACT_PAGE_BYTES,
  hiddenViewPrefix?: string,
): ArtifactPagerSource {
  const raw = () => readArtifactFile(path);
  if (!hiddenViewPrefix) return createBytePagerSource(path, pageBytes, raw);
  const prefix = Buffer.from(hiddenViewPrefix);
  return createBytePagerSource(path, pageBytes, async () => withoutArtifactPrefix(await raw(), prefix), raw);
}

async function scanForward(view: ArtifactByteView, needle: Buffer, start: number): Promise<number> {
  let offset = start;
  let carry = Buffer.alloc(0);
  while (offset < view.size) {
    const bytes = await view.read(offset, SEARCH_CHUNK_BYTES);
    if (bytes.length === 0) break;
    const haystack = Buffer.concat([carry, bytes]);
    const index = haystack.indexOf(needle);
    if (index >= 0) return offset - carry.length + index;
    carry = haystack.subarray(Math.max(0, haystack.length - needle.length + 1));
    offset += bytes.length;
  }
  return -1;
}

async function scanBackward(view: ArtifactByteView, needle: Buffer, end: number): Promise<number> {
  let offset = end;
  let carry = Buffer.alloc(0);
  while (offset > 0) {
    const start = Math.max(0, offset - SEARCH_CHUNK_BYTES);
    const bytes = await view.read(start, offset - start);
    const haystack = Buffer.concat([bytes, carry]);
    const index = haystack.lastIndexOf(needle);
    if (index >= 0) return start + index;
    carry = haystack.subarray(0, Math.min(needle.length - 1, haystack.length));
    offset = start;
  }
  return -1;
}

export function createBytePagerSource(
  path: string,
  pageBytes: number,
  readView: () => Promise<ArtifactByteView>,
  readFullView = readView,
): ArtifactPagerSource {
  const bounded = Math.max(1024, Math.min(MAX_PAGE_BYTES, Math.floor(pageBytes)));
  let disposed = false;
  const assertOpen = (): void => {
    if (disposed) throw new Error("artifact pager source is disposed");
  };
  const readPage = async (view: ArtifactByteView, offset: number): Promise<ArtifactPage> => {
    const total = view.size;
    const requested = Math.max(0, Math.min(Math.floor(offset), total));
    const buffer = await view.read(requested, bounded + 4);
    let start = 0;
    while (start < Math.min(4, buffer.length) && (buffer[start]! & 0xc0) === 0x80) start += 1;
    let end = Math.min(buffer.length, bounded);
    while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end += 1;
    const pageCount = Math.max(1, Math.ceil(total / bounded));
    return {
      body: buffer.toString("utf8", start, end),
      offset: requested,
      nextOffset: Math.min(total, requested + bounded),
      totalBytes: total,
      pageNumber: Math.min(pageCount, Math.floor(requested / bounded) + 1),
      pageCount,
    };
  };
  return {
    path,
    pageBytes: bounded,
    async readPage(offset) {
      assertOpen();
      return readPage(await readView(), offset);
    },
    async readTail() {
      assertOpen();
      const view = await readView();
      return readPage(view, Math.max(0, view.size - bounded));
    },
    async search(query, fromOffset = 0, reverse = false) {
      assertOpen();
      const view = await readView();
      const needle = Buffer.from(query, "utf8");
      if (needle.length === 0) return readPage(view, fromOffset);
      const start = Math.max(0, Math.min(fromOffset || (reverse ? view.size : 0), view.size));
      const match = reverse ? await scanBackward(view, needle, start) : await scanForward(view, needle, start);
      return match < 0 ? undefined : readPage(view, Math.max(0, match - Math.floor(bounded / 2)));
    },
    async readAll() {
      assertOpen();
      const view = await readFullView();
      if (view.size > MAX_FULL_ARTIFACT_EXPORT_BYTES) {
        throw new Error(
          `artifact is ${view.size.toLocaleString()} bytes; full copy/export is limited to ${MAX_FULL_ARTIFACT_EXPORT_BYTES.toLocaleString()} bytes. Scroll through it in the UI or open ${path} directly.`,
        );
      }
      return (await view.read(0, view.size)).toString("utf8");
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
          `artifact is ${data.length.toLocaleString()} bytes; full copy/export is limited to ${MAX_FULL_ARTIFACT_EXPORT_BYTES.toLocaleString()} bytes. Scroll through it in the UI instead.`,
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
