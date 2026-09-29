import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { wrapUserPrompt } from "../../ui-core/rendering/user-message-wrap.js";
import type { UserItem } from "../../ui-core/state/transcript-types.js";
import { sealStyle } from "../render/ansi-text.js";
import { clipRow, type BlockContext } from "./block-context.js";

export const USER_COLLAPSE_ROWS = 6;
const USER_KEPT_ROWS = 5;
const TEXT_COLUMN = 3;
const RIGHT_PAD = 1;

function userRow(ctx: BlockContext, body: string): string {
  const rail = ctx.ink.fg("userBorder", ctx.glyphs.userRail);
  const row = clipRow(ctx, `${rail} ${body}`);
  return ctx.ink.richColor ? ctx.ink.band(row, ctx.width, { bg: "userBg" }) : sealStyle(row);
}

export function buildUserLines(ctx: BlockContext, item: UserItem): string[] {
  const text = sanitizeDisplayText(item.text).replace(/\s+$/, "");
  const wrapped = wrapUserPrompt(text, ctx.width, TEXT_COLUMN + RIGHT_PAD);
  const body = wrapped.length > 0 ? wrapped : [""];

  const collapse = body.length > USER_COLLAPSE_ROWS;
  const shown = collapse ? body.slice(0, USER_KEPT_ROWS) : body;

  const lines = shown.map((line) => userRow(ctx, ctx.ink.fg("foreground", line)));
  if (collapse) {
    const hidden = body.length - USER_KEPT_ROWS;
    lines.push(
      userRow(ctx, ctx.ink.fg("muted", `${ctx.glyphs.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`)),
    );
  }
  return lines;
}
