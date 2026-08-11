import type { ResponderRuntimeState } from "../../app/controllers/session-responder.js";
import {
  responderStatusText,
  statusDensityForWidth,
} from "../../ui-core/rendering/status-segments.js";
import { clipToWidth } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";

export interface ResponderViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly state: ResponderRuntimeState;
}

export function responderVisible(state: ResponderRuntimeState): boolean {
  if (state.mode === "listening") return true;
  return state.running + state.ready + state.delivered > 0;
}

export function responderRow(input: ResponderViewInput): string {
  const { ink, state } = input;
  const density = statusDensityForWidth(input.columns);
  const compact = density === "xs" || density === "sm";
  const active = state.running > 0;
  const bullet = ink.fg(active ? "spinner" : "muted", ink.glyphs.taskActive);
  const jobs = ink.fg("muted", `${ink.glyphs.separator} ^J jobs`);

  return clipToWidth(
    `${bullet} ${ink.fg("muted", responderStatusText(state, compact))} ${jobs}`,
    Math.max(1, Math.floor(input.columns)),
    ink.glyphs.ellipsis,
  );
}
