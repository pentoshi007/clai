import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { compactionElapsedLabel } from "../../ui-core/rendering/duration.js";
import { liveCompactionHeadTail } from "../../ui-core/rendering/thinking-tail.js";
import { compactionTokenLabel, isItemExpanded, type CompactedItem } from "../../ui-core/state/transcript-types.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { joinMeta, type BlockContext } from "./block-context.js";
import { appendDisclosure } from "./disclosure-lines.js";
import { logicalOutputLines, outputBodyRows, OUTPUT_PREVIEW_LINES } from "./output-lines.js";

export function buildCompactedLines(ctx: BlockContext, item: CompactedItem): string[] {
  const expanded = isItemExpanded(ctx.state, item);
  const label = compactionTokenLabel(item);
  const elapsed = compactionElapsedLabel(item, ctx.now);
  const token = item.error ? "activity" : "cyan";
  const mark = ctx.ink.unicode ? "•" : "*";
  const head = joinMeta(ctx, [item.error ? "Compaction failed" : "Compacted context", elapsed, label || undefined]);
  const lines = wrapWithPrefixes(head, { width: ctx.width, firstPrefix: `${mark} `, nextPrefix: "  " })
    .map((row) => ctx.ink.fg(token, row));
  const summary = item.error ?? (item.streaming && !expanded ? liveCompactionHeadTail(item.summary) : item.summary);
  const source = logicalOutputLines(sanitizeDisplayText(summary));
  lines.push(...outputBodyRows(ctx, source, expanded, { token: item.error ? "activity" : "muted" }));
  appendDisclosure(ctx, lines, expanded, { hidden: Math.max(0, source.length - OUTPUT_PREVIEW_LINES) });
  return lines;
}
