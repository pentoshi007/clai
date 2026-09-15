import type { SubagentsRuntimeState } from "../../app/controllers/session-controller.js";
import { clipToWidth } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";

export interface SubagentsViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly state: SubagentsRuntimeState;
}

export function subagentsVisible(state: SubagentsRuntimeState): boolean {
  return state.total > 0;
}

export function subagentsRow(input: SubagentsViewInput): string {
  const { ink, state } = input;
  const active = state.running > 0;
  const bullet = ink.fg(active ? "spinner" : "muted", ink.glyphs.assistantBullet);
  const summary = ink.fg(
    active ? "spinner" : "muted",
    `${state.running} running ${ink.glyphs.separator} ${state.settled} done`,
  );
  const inspect = ink.fg("muted", `${ink.glyphs.separator} /agents inspect`);

  return clipToWidth(
    `${bullet} ${summary} ${inspect}`,
    Math.max(1, Math.floor(input.columns)),
    ink.glyphs.ellipsis,
  );
}
