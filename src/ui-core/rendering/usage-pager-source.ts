import {
  DEFAULT_ARTIFACT_PAGE_BYTES,
  type ArtifactPage,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";

export interface UsagePagerSourcePorts {
  readonly subscribe: (listener: () => void) => () => void;
  readonly renderBody: () => string;
}

export function createUsagePagerSource(
  ports: UsagePagerSourcePorts,
  pageBytes = DEFAULT_ARTIFACT_PAGE_BYTES,
): ArtifactPagerSource {
  const boundedPageBytes = Math.max(1024, Math.floor(pageBytes));
  let body = ports.renderBody();
  let disposed = false;
  const listeners = new Set<() => void>();
  const unsubscribe = ports.subscribe(() => {
    if (disposed) return;
    const next = ports.renderBody();
    if (next === body) return;
    body = next;
    for (const listener of [...listeners]) listener();
  });

  const readPage = async (offset: number): Promise<ArtifactPage> => {
    if (disposed) throw new Error("usage pager source is disposed");
    const data = Buffer.from(body, "utf8");
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
      pageNumber: Math.min(
        pageCount,
        Math.floor(requested / boundedPageBytes) + 1,
      ),
      pageCount,
    };
  };

  return {
    path: "memory://usage",
    pageBytes: boundedPageBytes,
    readPage,
    readTail: () =>
      readPage(Math.max(0, Buffer.byteLength(body, "utf8") - boundedPageBytes)),
    async search(query, fromOffset = 0, reverse = false) {
      if (disposed) throw new Error("usage pager source is disposed");
      const from = reverse
        ? Math.max(0, (fromOffset || body.length) - 1)
        : Math.max(0, fromOffset);
      const index = reverse
        ? body.lastIndexOf(query, from)
        : body.indexOf(query, from);
      return index < 0
        ? undefined
        : readPage(Math.max(0, index - Math.floor(boundedPageBytes / 2)));
    },
    readAll: async () => {
      if (disposed) throw new Error("usage pager source is disposed");
      return body;
    },
    watch(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    isGrowing: () => true,
    dispose() {
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
