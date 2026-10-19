import { sliceSpans, syntaxColor } from "../../ui-core/rendering/file-diff-view.js";
import { wrapPagerLine } from "../../ui-core/rendering/pager-chrome.js";
import type { PagerBodyRegions } from "../../ui-core/rendering/pager-regions.js";
import { emptyCarry, highlightLineForPath, type SyntaxSpan } from "../../ui-core/rendering/syntax-highlight.js";
import { sealStyle } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";

const HIGHLIGHT_LINE_LIMIT = 5_000;

function paintCode(ink: InkTheme, spans: readonly SyntaxSpan[], chunk: string): string {
  if (spans.length === 0) return ink.fg("foreground", chunk);
  let out = "";
  for (const span of spans) out += ink.hex(syntaxColor(span.kind, ink.theme), span.text);
  return sealStyle(out);
}

export function regionPagerLines(
  logical: readonly string[],
  width: number,
  regions: PagerBodyRegions,
  path: string | undefined,
  ink: InkTheme,
): readonly string[] {
  const inputEnd = regions.inputEnd ?? 0;
  const codeStart = path ? regions.codeStart : undefined;
  const codeEnd = Math.min(regions.codeEnd ?? logical.length, codeStart === undefined ? 0 : codeStart + HIGHLIGHT_LINE_LIMIT);
  const carry = emptyCarry();
  const out: string[] = [];
  logical.forEach((line, index) => {
    const chunks = wrapPagerLine(line, width, { preserveWhitespace: true });
    if (index < inputEnd) {
      for (const chunk of chunks) out.push(ink.fg("aqua", chunk));
      return;
    }
    const spans = path && codeStart !== undefined && index >= codeStart && index < codeEnd
      ? highlightLineForPath(line, path, carry)
      : undefined;
    if (!spans) {
      for (const chunk of chunks) out.push(ink.fg("foreground", chunk));
      return;
    }
    let offset = 0;
    for (const chunk of chunks) {
      out.push(paintCode(ink, sliceSpans(spans, offset, offset + chunk.length), chunk));
      offset += chunk.length;
    }
  });
  return out;
}
