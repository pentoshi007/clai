import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { thinkingElapsedLabel } from "../../ui-core/rendering/duration.js";
import {
  EMPTY_MARKDOWN_STREAM_CACHE,
  renderStreamingMarkdown,
  type MarkdownStreamCache,
} from "../../ui-core/rendering/streaming-markdown.js";
import { isItemExpanded, type ThinkingItem } from "../../ui-core/state/transcript-types.js";
import { clipRow, joinMeta, type BlockContext } from "./block-context.js";
import { appendDisclosure } from "./disclosure-lines.js";
import { outputBodyRows } from "./output-lines.js";

export interface ThinkingLinesResult {
  readonly lines: string[];
  readonly cache: MarkdownStreamCache;
}

function thinkingTokenLabel(content: string): string | undefined {
  if (!content.trim()) return undefined;
  return `~${Math.max(1, Math.round(content.length / 4)).toLocaleString()} tokens`;
}

export function buildThinkingLines(ctx: BlockContext, item: ThinkingItem): string[] {
  return renderThinkingLines(ctx, item).lines;
}

export function renderThinkingLines(ctx: BlockContext, item: ThinkingItem): ThinkingLinesResult {
  const content = sanitizeDisplayText(item.content);
  if (!content.trim() && !item.streaming) return { lines: [], cache: EMPTY_MARKDOWN_STREAM_CACHE };
  const expanded = isItemExpanded(ctx.state, item);
  const elapsed = thinkingElapsedLabel(item, ctx.now);
  const mark = ctx.ink.unicode ? "•" : "*";
  const title = ctx.ink.style(`${mark} ${item.streaming ? "Thinking" : "Reasoning"}`, { fg: "thinking", bold: true });
  const tokens = thinkingTokenLabel(content);
  const head = joinMeta(ctx, [
    title,
    elapsed ? ctx.ink.fg("userBorder", elapsed) : undefined,
    tokens ? ctx.ink.fg("userBorder", tokens) : undefined,
  ]);
  const lines = [clipRow(ctx, head)];
  appendDisclosure(ctx, lines, expanded, { chord: "Ctrl+T", inline: true });
  if (!expanded) return { lines, cache: EMPTY_MARKDOWN_STREAM_CACHE };
  const rendered = renderStreamingMarkdown({
    text: content,
    streaming: item.streaming,
    options: {
      width: Math.max(20, ctx.width - 2),
      stripOuterIndent: true,
      isolateBold: true,
      theme: ctx.ink.theme,
      colorMode: ctx.ink.colorMode,
    },
    cache: ctx.markdownCache ?? EMPTY_MARKDOWN_STREAM_CACHE,
  });
  lines.push(...outputBodyRows(ctx, rendered.lines, true, { token: "thinking", branch: false }));
  return { lines, cache: rendered.cache };
}
