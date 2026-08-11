import { parseContextLimitInput } from "../../ui-core/rendering/context-limit.js";
import { clipToWidth } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";

export interface ContextLimitEditorState {
  readonly editing: boolean;
  readonly draft: string;
}

export function contextLimitEditorLabel(
  ink: InkTheme,
  state: ContextLimitEditorState,
  width: number,
): string {
  if (!state.editing) return "";
  const value = state.draft || "1m or 253k";
  const label = `${ink.fg("muted", "ctx limit ")}${ink.fg("inputBorder", `${value}${ink.glyphs.caret}`)} ${ink.fg("muted", `${ink.glyphs.enter} save · esc cancel · empty reset`)}`;
  return clipToWidth(label, Math.max(1, width), ink.glyphs.ellipsis);
}

export function contextLimitInput(value: string): number | undefined | null {
  return parseContextLimitInput(value);
}
