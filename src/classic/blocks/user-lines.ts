import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { wrapUserPrompt } from "../../ui-core/rendering/user-message-wrap.js";
import type { UserItem } from "../../ui-core/state/transcript-types.js";
import { clipRow, type BlockContext } from "./block-context.js";

/** Rows kept before a live user prompt collapses (04-UI-SPEC §3.2). */
export const USER_COLLAPSE_ROWS = 6;
const USER_KEPT_ROWS = 5;
const PLATE = " YOU ";
const TEXT_COLUMN = 7;

export function buildUserLines(ctx: BlockContext, item: UserItem): string[] {
  const rail = ctx.ink.fg("userBorder", ctx.glyphs.userRail);
  const plate = ctx.ink.plate("prompt", PLATE);
  const head = `${rail}${plate} `;
  const cont = `${rail}${" ".repeat(TEXT_COLUMN - 1)}`;

  const text = sanitizeDisplayText(item.text).replace(/\s+$/, "");
  const wrapped = wrapUserPrompt(text, ctx.width, TEXT_COLUMN);
  const body = wrapped.length > 0 ? wrapped : [""];

  const collapse = body.length > USER_COLLAPSE_ROWS;
  const shown = collapse ? body.slice(0, USER_KEPT_ROWS) : body;

  const lines = shown.map((line, index) =>
    clipRow(ctx, `${index === 0 ? head : cont}${ctx.ink.fg("white", line)}`),
  );
  if (collapse) {
    const hidden = body.length - USER_KEPT_ROWS;
    lines.push(
      clipRow(
        ctx,
        `${cont}${ctx.ink.fg("muted", `${ctx.glyphs.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`)}`,
      ),
    );
  }
  return lines;
}
