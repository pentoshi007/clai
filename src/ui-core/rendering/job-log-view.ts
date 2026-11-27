import {
  readArtifactFile,
  withoutArtifactPrefix,
  type ArtifactByteView,
} from "./artifact-pager-source.js";

export interface JobLogFile {
  readonly path: string;
  readonly hiddenPrefix?: Buffer | undefined;
  readonly waitForPrefix?: boolean | undefined;
}

interface LogSpan {
  readonly path: string;
  readonly view: ArtifactByteView;
  readonly start: number;
  readonly length: number;
  readonly offset: number;
}

function firstSpanAt(spans: readonly LogSpan[], offset: number): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle]!;
    if (span.offset + span.length <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function readSpans(spans: readonly LogSpan[], offset: number, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const end = offset + length;
  const parts: Buffer[] = [];
  for (let index = firstSpanAt(spans, offset); index < spans.length; index++) {
    const span = spans[index]!;
    if (span.offset >= end) break;
    const start = Math.max(0, offset - span.offset);
    const count = Math.min(span.length, end - span.offset) - start;
    parts.push(await span.view.read(span.start + start, count));
  }
  return Buffer.concat(parts);
}

async function readLogFile(file: JobLogFile): Promise<ArtifactByteView> {
  const view = await readArtifactFile(file.path, true);
  return file.hiddenPrefix ? withoutArtifactPrefix(view, file.hiddenPrefix, file.waitForPrefix) : view;
}

function withPreview(spans: readonly LogSpan[], committed: number, preview: readonly string[]): ArtifactByteView {
  const draft = preview.join("\n");
  const suffix = Buffer.from(draft && committed > 0 ? `\n${draft}` : draft);
  const size = committed + suffix.length;
  return {
    size,
    async read(start, length) {
      const end = Math.min(start + length, size);
      const body = await readSpans(spans, start, Math.max(0, Math.min(end, committed) - start));
      if (end <= committed) return body;
      const trailing = suffix.subarray(Math.max(0, start - committed), end - committed);
      return body.length ? Buffer.concat([body, trailing]) : trailing;
    },
  };
}

export function createJobLogView(files: () => readonly JobLogFile[], preview: () => readonly string[]): () => Promise<ArtifactByteView> {
  const seen = new Map<string, number>();
  let spans: LogSpan[] = [];
  let size = 0;
  let previous: Promise<unknown> = Promise.resolve();
  let queued: Promise<ArtifactByteView> | undefined;

  function observe(path: string, view: ArtifactByteView): void {
    const start = seen.get(path) ?? 0;
    const length = view.size - start;
    if (length <= 0) return;
    const last = spans.at(-1);
    if (last?.path === path) {
      spans[spans.length - 1] = { ...last, length: last.length + length, view };
    } else {
      spans.push({ path, view, start, length, offset: size });
    }
    seen.set(path, view.size);
    size += length;
  }

  async function snapshot(): Promise<ArtifactByteView> {
    const logs = await Promise.all(files().map(async (file) => ({ path: file.path, view: await readLogFile(file) })));
    if (logs.some(({ path, view }) => view.size < (seen.get(path) ?? 0))) {
      seen.clear();
      spans = [];
      size = 0;
    }
    for (const { path, view } of logs) observe(path, view);
    return withPreview(spans, size, preview());
  }

  return () => {
    if (queued) return queued;
    const next = previous.then(() => {
      queued = undefined;
      return snapshot();
    });
    queued = next;
    previous = next.catch(() => undefined);
    return next;
  };
}
