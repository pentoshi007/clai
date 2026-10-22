import type { TurnSummaryItem } from "../../ui-core/state/transcript-types.js";
import { tokensPerSecondLabel, turnSummaryLabel } from "../../ui-core/rendering/duration.js";
import { lineChangeLabels } from "../../ui-core/rendering/line-change-labels.js";
import { wrapAnsiLine } from "../render/wrap.js";
import type { BlockContext } from "./block-context.js";

export function buildTurnSummaryLines(ctx: BlockContext, item: TurnSummaryItem): string[] {
  const mark = ctx.ink.unicode ? "✻" : "*";
  const timing = ctx.ink.fg("muted", `${mark} ${turnSummaryLabel(item.durationMs, item.status)}`);
  const changes = lineChangeLabels(item.changes);
  const counts = changes
    ? `${ctx.ink.fg("muted", " · ")}${ctx.ink.fg("success", changes.added)} ${ctx.ink.fg("diffDel", changes.removed)}`
    : "";
  const tps = tokensPerSecondLabel(item.generation);
  const suffix = `${changes ? " · /changes" : ""}${tps ? ` · ${tps}` : ""}`;
  return wrapAnsiLine(timing + counts + ctx.ink.fg("muted", suffix), ctx.width);
}
