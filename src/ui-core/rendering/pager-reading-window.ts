import type { ArtifactPage, ArtifactPagerSource } from "./artifact-pager-source.js";

export type ReadingWindow = ArtifactPage & { readonly parts?: readonly ArtifactPage[] };
export type ScrollDirection = -1 | 1;

function joined(parts: readonly ArtifactPage[]): ReadingWindow {
  const first = parts[0]!;
  const last = parts.at(-1)!;
  return { ...first, parts, body: parts.map(part => part.body).join(""), nextOffset: last.nextOffset, totalBytes: last.totalBytes };
}

export function canExtend(window: ReadingWindow, direction: ScrollDirection): boolean {
  return direction < 0 ? window.offset > 0 : window.nextOffset < window.totalBytes;
}

function prefixTo(page: ArtifactPage, end: number): ArtifactPage {
  if (page.nextOffset <= end) return page;
  const bytes = Buffer.from(page.body);
  let cut = end - page.offset;
  while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
  return { ...page, nextOffset: end, body: bytes.toString("utf8", 0, cut) };
}

export async function shiftReadingWindow(source: ArtifactPagerSource, window: ReadingWindow, direction: ScrollDirection): Promise<{ window: ReadingWindow; changedAtTop: boolean }> {
  const parts = window.parts ?? [window];
  if (parts.length >= 3) {
    const retained = direction > 0 ? parts.slice(1) : parts.slice(0, -1);
    return { window: joined(retained), changedAtTop: direction > 0 };
  }
  if (direction > 0) {
    const next = await source.readPage(window.nextOffset);
    return { window: joined([...parts, next]), changedAtTop: false };
  }
  const previous = await source.readPage(Math.max(0, window.offset - source.pageBytes));
  return { window: joined([prefixTo(previous, window.offset), ...parts]), changedAtTop: true };
}

export async function refreshReadingWindow(source: ArtifactPagerSource, window: ReadingWindow | undefined): Promise<ReadingWindow> {
  const first = await source.readPage(window?.offset ?? 0);
  const count = window?.parts?.length ?? 1;
  const parts = [first];
  let last = first;
  while (parts.length < count && last.nextOffset < last.totalBytes && last.nextOffset > last.offset) {
    last = await source.readPage(last.nextOffset);
    parts.push(last);
  }
  return parts.length === 1 ? first : joined(parts);
}
