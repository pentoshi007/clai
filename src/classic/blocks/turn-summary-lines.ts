import type { TurnSummaryItem } from "../../ui-core/state/transcript-types.js";
import { turnSummaryLabel } from "../../ui-core/rendering/duration.js";
import { clipRow, type BlockContext } from "./block-context.js";

export function buildTurnSummaryLines(ctx: BlockContext, item: TurnSummaryItem): string[] {
  const mark = ctx.ink.unicode ? "✻" : "*";
  return [clipRow(ctx, ctx.ink.fg("muted", `${mark} ${turnSummaryLabel(item.durationMs, item.status)}`))];
}
