import {
  EMPTY_MARKDOWN_STREAM_CACHE,
  renderStreamingMarkdown,
  type MarkdownStreamCache,
} from "../../ui-core/rendering/streaming-markdown.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { stripToolCallSurfaces } from "../../ui-core/rendering/strip-tool-surfaces.js";
import type { AssistantItem } from "../../ui-core/state/transcript-types.js";
import { sealStyle, trimTrailingSpaces } from "../render/ansi-text.js";
import { withColorMode } from "../render/ink-theme.js";
import { clipRow, type BlockContext } from "./block-context.js";

export interface AssistantLinesResult {
  readonly lines: string[];
  readonly cache: MarkdownStreamCache;
}

/** Gutter columns consumed by `◆ ` plus the reserved right column. */
export const ASSISTANT_CHROME_COLS = 2;

export function buildAssistantLines(
  ctx: BlockContext,
  item: AssistantItem,
): AssistantLinesResult {
  const source = sanitizeDisplayText(stripToolCallSurfaces(item.text));
  const bullet = ctx.ink.fg("magenta", `${ctx.glyphs.assistantBullet} `);
  const indent = "  ";

  if (!source.trim()) {
    if (!item.streaming) return { lines: [], cache: EMPTY_MARKDOWN_STREAM_CACHE };
    return {
      lines: [clipRow(ctx, `${bullet}${ctx.ink.dim(ctx.glyphs.ellipsis)}`)],
      cache: EMPTY_MARKDOWN_STREAM_CACHE,
    };
  }

  const rendered = withColorMode(ctx.ink.colorMode, () =>
    renderStreamingMarkdown({
      text: source,
      streaming: item.streaming,
      options: {
        width: Math.max(20, ctx.width - ASSISTANT_CHROME_COLS),
        stripOuterIndent: true,
      },
      cache: ctx.markdownCache ?? EMPTY_MARKDOWN_STREAM_CACHE,
    }),
  );

  const body = rendered.lines.length > 0 ? rendered.lines : [""];
  const lines = body.map((line, index) => {
    if (line.trim() === "") return "";
    const styled = line.includes("\x1b") ? line : ctx.ink.fg("response", line);
    return trimTrailingSpaces(`${index === 0 ? bullet : indent}${styled}`);
  });

  if (item.streaming && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = trimTrailingSpaces(
      sealStyle(`${lines[last]}${ctx.ink.dim(ctx.glyphs.ellipsis)}`),
    );
  }
  return { lines, cache: rendered.cache };
}
