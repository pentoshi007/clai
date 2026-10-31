import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { GOAL_GLYPH, GOAL_GLYPH_ASCII } from "../../ui-core/rendering/goal-format.js";
import type { NoticeItem } from "../../ui-core/state/transcript-types.js";
import type { ThemeToken } from "../render/ink-theme.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { clipRow, type BlockContext } from "./block-context.js";

function noticeToken(item: NoticeItem): ThemeToken {
  if (item.level === "error") return "diffDel";
  if (item.level === "warn") return "activity";
  return item.tone === "goal" ? "magenta" : "muted";
}

function noticeMark(ctx: BlockContext, item: NoticeItem): string {
  if (item.tone === "goal") return ctx.ink.unicode ? GOAL_GLYPH : GOAL_GLYPH_ASCII;
  if (item.level === "warn") return ctx.glyphs.warning;
  return ctx.ink.unicode ? "•" : "*";
}

export function buildNoticeLines(ctx: BlockContext, item: NoticeItem): string[] {
  const token = noticeToken(item);
  return wrapWithPrefixes(sanitizeDisplayText(item.text), { width: ctx.width, firstPrefix: `${noticeMark(ctx, item)} `, nextPrefix: "  " })
    .map((row) => clipRow(ctx, ctx.ink.fg(token, row)));
}
