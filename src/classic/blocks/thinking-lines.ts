import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { thinkingElapsedLabel } from "../../ui-core/rendering/duration.js";
import { liveThinkingDisplay } from "../../ui-core/rendering/thinking-tail.js";
import { isItemExpanded, type ThinkingItem } from "../../ui-core/state/transcript-types.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { clipRow, joinMeta, type BlockContext } from "./block-context.js";

/** Rough token estimate from content length — never a re-tokenization. */
export function thinkingTokenEstimate(content: string): number {
  return Math.max(1, Math.round(content.trim().length / 4));
}

export function buildThinkingLines(ctx: BlockContext, item: ThinkingItem): string[] {
  const gutter = ctx.ink.style(`${ctx.glyphs.thinkingGutter} `, {
    fg: "thinking",
  });
  const expanded = isItemExpanded(ctx.state, item);
  const content = sanitizeDisplayText(item.content);
  const elapsed = thinkingElapsedLabel(item, ctx.now);

  const header = (): string =>
    clipRow(
      ctx,
      `${gutter}${ctx.ink.style(
        joinMeta(ctx, [
          "thinking",
          elapsed,
          `${thinkingTokenEstimate(content).toLocaleString()} tokens`,
          item.streaming
            ? expanded
              ? "live · Ctrl+T to collapse when done"
              : "live · Ctrl+T to keep open"
            : expanded
              ? "Ctrl+T to hide"
              : "Ctrl+T to expand",
        ]),
        { fg: "thinking" },
      )}`,
    );

  const bodyRows = (text: string): string[] =>
    wrapWithPrefixes(text, { width: ctx.width - 2 }).map((row) =>
      clipRow(
        ctx,
        `${gutter}${ctx.ink.style(row, { fg: "thinking", italic: true })}`,
      ),
    );

  if (item.streaming) {
    const tail = liveThinkingDisplay(content);
    if (!tail.trim()) return [header()];
    return [header(), ...bodyRows(tail)];
  }

  if (!content.trim()) return [];
  if (!expanded) return [header()];
  return [header(), ...bodyRows(content)];
}
