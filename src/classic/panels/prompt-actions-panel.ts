import type { PromptActionsRequest } from "../../ui-core/controllers/overlay-controller.js";
import type { InkTheme } from "../render/ink-theme.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { listWindow } from "./list-window.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";

export interface PromptActionsPanelState {
  readonly top: number;
}

export const PROMPT_ACTIONS_INITIAL_STATE: PromptActionsPanelState = { top: 0 };

export function promptLines(prompt: string, columns: number): readonly string[] {
  return wrapWithPrefixes(prompt.replace(/\r/g, ""), {
    width: panelBodyWidth(columns),
  });
}

export interface PromptActionsKeyInput {
  readonly state: PromptActionsPanelState;
  readonly chord: string;
  readonly request: PromptActionsRequest;
  readonly lineCount: number;
  readonly rows: number;
}

export function promptActionsKey(
  input: PromptActionsKeyInput,
): PanelKeyResult<PromptActionsPanelState> {
  const { state, chord } = input;
  const height = Math.max(1, panelBodyHeight(input.rows));
  const max = Math.max(0, input.lineCount - height);

  if (chord === "c") {
    return handled(state, { kind: "copy", text: input.request.prompt }, { kind: "close" });
  }
  if (chord === "r" || chord === "enter") {
    return handled(state, { kind: "resend" }, { kind: "close" });
  }
  if (chord === "e") {
    return handled(
      state,
      { kind: "edit-prompt", text: input.request.prompt },
      { kind: "close" },
    );
  }
  if (chord === "up" || chord === "k") {
    return handled({ top: Math.max(0, state.top - 1) });
  }
  if (chord === "down" || chord === "j") {
    return handled({ top: Math.min(max, state.top + 1) });
  }
  if (chord === "q") return handled(state, { kind: "close" });
  return unhandled(state);
}

export interface PromptActionsViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly request: PromptActionsRequest;
  readonly state: PromptActionsPanelState;
}

export function promptActionsView(input: PromptActionsViewInput): PanelFrameInput {
  const { ink, state } = input;
  const lines = promptLines(input.request.prompt, input.columns);
  const height = panelBodyHeight(input.rows);
  const window = listWindow({
    count: lines.length,
    active: state.top,
    height: Math.max(1, height),
    previousTop: state.top,
    margin: 0,
  });
  const body = lines.slice(window.top, window.top + window.height);

  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: "Prompt",
    borderColor: "userBorder",
    counter:
      lines.length > height ? `${window.top + 1}/${lines.length}` : undefined,
    hints: ["c copy", "r resend", "e edit", "esc close"],
    body,
  };
}
