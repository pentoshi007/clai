import type { PagerLineSegment } from "../../ui-core/state/pager-search.js";
import { sealStyle, tokenize } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";

const FULL_RESET = /^\x1b\[0*m$/;

interface Marks {
  readonly open: string;
  readonly close: string;
}

function marksFor(ink: InkTheme, kind: PagerLineSegment["kind"]): Marks | undefined {
  if (kind === "plain") return undefined;
  const sample = kind === "active" ? ink.style("\u0000", { inverse: true, bold: true }) : ink.inverse("\u0000");
  const [open = "", close = ""] = sample.split("\u0000");
  return open ? { open, close } : undefined;
}

export function paintSearchMatches(ink: InkTheme, styled: string, segments: readonly PagerLineSegment[]): string {
  const ranges: { start: number; end: number; marks: Marks }[] = [];
  let offset = 0;
  for (const segment of segments) {
    const marks = marksFor(ink, segment.kind);
    if (marks) ranges.push({ start: offset, end: offset + segment.text.length, marks });
    offset += segment.text.length;
  }
  if (ranges.length === 0) return sealStyle(styled);
  let out = "";
  let position = 0;
  let range = 0;
  let open: Marks | undefined;
  const advance = (): void => {
    while (range < ranges.length && ranges[range]!.end <= position) range += 1;
  };
  for (const token of tokenize(styled)) {
    if (token.kind === "escape") {
      out += token.value;
      if (open && FULL_RESET.test(token.value)) out += open.open;
      continue;
    }
    let text = token.value;
    while (text.length > 0) {
      advance();
      const current = ranges[range];
      if (open && (!current || position < current.start || position >= current.end)) {
        out += open.close;
        open = undefined;
      }
      if (!open && current && position >= current.start && position < current.end) {
        open = current.marks;
        out += open.open;
      }
      const boundary = open ? current!.end : current ? current.start : position + text.length;
      const take = Math.max(1, Math.min(text.length, boundary - position));
      out += text.slice(0, take);
      text = text.slice(take);
      position += take;
    }
  }
  if (open) out += open.close;
  return sealStyle(out);
}
