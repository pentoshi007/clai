import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { wrapUserPrompt } from "../../ui-core/rendering/user-message-wrap.js";
import type { UserItem } from "../../ui-core/state/transcript-types.js";
import { sealStyle } from "../render/ansi-text.js";
import { clipRow, type BlockContext } from "./block-context.js";
import { appendDisclosure } from "./disclosure-lines.js";

export const USER_COLLAPSE_ROWS = 6;
const USER_KEPT_ROWS = 5;

export function buildUserLines(ctx: BlockContext, item: UserItem): string[] {
  const text = sanitizeDisplayText(item.text).replace(/\s+$/, "");
  const body = wrapUserPrompt(text, ctx.width, 3);
  const expanded = ctx.state.itemOverrides.get(item.id) ?? false;
  const collapse = !expanded && body.length > USER_COLLAPSE_ROWS;
  const shown = collapse ? body.slice(0, USER_KEPT_ROWS) : body;
  const mark = ctx.ink.fg("userBorder", ctx.ink.unicode ? "› " : "> ");
  const lines = shown.map((line, index) => clipRow(ctx, `${index === 0 ? mark : "  "}${ctx.ink.fg("foreground", line)}`));
  if (collapse || expanded && body.length > USER_COLLAPSE_ROWS) {
    appendDisclosure(ctx, lines, expanded, { hidden: body.length - shown.length, indent: 2, chord: "Enter" });
  }
  return lines.map((row) => ctx.ink.richColor ? ctx.ink.band(row, ctx.width, { bg: "userBg" }) : sealStyle(row));
}
