import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { thinkingElapsedLabel } from "../../ui-core/rendering/duration.js";
import { isItemExpanded, type ThinkingItem } from "../../ui-core/state/transcript-types.js";
import { clipRow, joinMeta, type BlockContext } from "./block-context.js";
import { appendDisclosure } from "./disclosure-lines.js";
import { logicalOutputLines, outputBodyRows } from "./output-lines.js";

export function buildThinkingLines(ctx: BlockContext, item: ThinkingItem): string[] {
  const content = sanitizeDisplayText(item.content);
  if (!content.trim() && !item.streaming) return [];
  const expanded = isItemExpanded(ctx.state, item);
  const elapsed = thinkingElapsedLabel(item, ctx.now);
  const mark = ctx.ink.unicode ? "•" : "*";
  const title = ctx.ink.style(`${mark} ${item.streaming ? "Thinking" : "Reasoning"}`, { fg: "thinking", bold: true });
  const head = joinMeta(ctx, [title, elapsed ? ctx.ink.fg("userBorder", elapsed) : undefined]);
  const lines = [clipRow(ctx, head)];
  if (!item.streaming) appendDisclosure(ctx, lines, expanded, { chord: "Ctrl+T", inline: true });
  if (expanded || item.streaming) {
    const body = outputBodyRows(ctx, logicalOutputLines(content), true, { token: "thinking", branch: false });
    lines.push(...body);
  }
  return lines;
}
