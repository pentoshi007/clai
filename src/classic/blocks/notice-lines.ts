import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import type { NoticeItem, NoticeLevel } from "../../ui-core/state/transcript-types.js";
import type { ThemeToken } from "../render/ink-theme.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { clipRow, type BlockContext } from "./block-context.js";

/** Fixed-width plates so the body column never shifts between levels. */
const PLATE_LABEL: Record<NoticeLevel, string> = {
  warn: " WARN ",
  error: " ERR  ",
  info: " INFO ",
};

/** Same plate tokens the toast row uses, so the two surfaces cannot drift. */
const PLATE_TOKEN: Record<NoticeLevel, ThemeToken> = {
  warn: "activityBg",
  error: "failedBg",
  info: "chip",
};

const BODY_COLUMN = 7;

/**
 * Notices reach the feed only through hydrated history — live notices are
 * routed to `toast.show` by the composition root and never become rows.
 */
export function buildNoticeLines(ctx: BlockContext, item: NoticeItem): string[] {
  const plate = ctx.ink.plate(PLATE_TOKEN[item.level], PLATE_LABEL[item.level]);
  const text = sanitizeDisplayText(item.text);
  const rows = wrapWithPrefixes(text, { width: Math.max(1, ctx.width - BODY_COLUMN) });
  const indent = " ".repeat(BODY_COLUMN);
  return rows.map((row, index) =>
    clipRow(ctx, index === 0 ? `${plate} ${row}` : `${indent}${row}`),
  );
}
