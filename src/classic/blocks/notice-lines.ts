import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import type { NoticeItem } from "../../ui-core/state/transcript-types.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { clipRow, type BlockContext } from "./block-context.js";

export function buildNoticeLines(ctx: BlockContext, item: NoticeItem): string[] {
  const token = item.level === "error" ? "diffDel" : item.level === "warn" ? "activity" : "muted";
  const mark = item.level === "warn" ? ctx.glyphs.warning : ctx.ink.unicode ? "•" : "*";
  return wrapWithPrefixes(sanitizeDisplayText(item.text), { width: ctx.width, firstPrefix: `${mark} `, nextPrefix: "  " })
    .map((row) => clipRow(ctx, ctx.ink.fg(token, row)));
}
