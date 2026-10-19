import type { TranscriptItem } from "../../ui-core/state/transcript-types.js";

function textRows(text: string, width: number): number {
  let rows = 0;
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    const length = (end < 0 ? text.length : end) - start;
    rows += Math.max(1, Math.ceil(length / Math.max(1, width)));
    if (end < 0) return rows;
    start = end + 1;
  }
}

export function estimatedBlockRows(item: TranscriptItem, width: number): number {
  switch (item.kind) {
    case "assistant": return textRows(item.text, width);
    case "user": return Math.min(12, textRows(item.text, Math.max(1, width - 4))) + 2;
    case "thinking": return 2;
    case "tool": return 6;
    case "compacted": return 3;
    case "turn-summary": return 2;
    case "notice": return textRows(item.text, width);
  }
}
