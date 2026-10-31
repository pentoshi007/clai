import type { GoalView } from "../../app/controllers/goal-types.js";
import {
  GOAL_GLYPH,
  GOAL_GLYPH_ASCII,
  goalStripModel,
  type GoalStripTone,
} from "../../ui-core/rendering/goal-format.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { clipToWidth } from "../render/ansi-text.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";

export interface GoalRowInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly goal: GoalView | undefined;
  readonly now: number;
  readonly running: boolean;
}

const TONE_TOKEN: Record<GoalStripTone, ThemeToken> = {
  active: "magenta",
  busy: "spinner",
  paused: "activity",
};

export function goalVisible(goal: GoalView | undefined): boolean {
  return goal !== undefined;
}

export function goalRow(input: GoalRowInput): string {
  const { ink, goal } = input;
  if (!goal) return "";
  const model = goalStripModel(goal, input.now, input.running);
  const separator = ink.glyphs.separator;
  const token = TONE_TOKEN[model.tone];
  const head = ink.fg(token, `${ink.unicode ? GOAL_GLYPH : GOAL_GLYPH_ASCII} ${model.label}`);
  const details = model.details.map((detail) => ink.fg("muted", detail));
  const objective = ink.fg("muted", sanitizeDisplayText(model.objective).replace(/\s+/g, " "));
  return clipToWidth(
    [head, ...details, objective].join(` ${ink.fg("muted", separator)} `),
    Math.max(1, Math.floor(input.columns)),
    ink.glyphs.ellipsis,
  );
}
