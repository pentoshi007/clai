import { SecretBuffer } from "../../ui-core/composer/secret-buffer.js";
import type { SecretRequestView } from "../../ui-core/controllers/overlay-controller.js";
import { clipToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";
import { stripAnsi } from "../render/measure.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, type PanelKeyResult } from "./panel-effect.js";
import { isPrintable } from "./picker-panel.js";

export interface SecretPanelState {
  readonly buffer: SecretBuffer;
  readonly cursor: number;
}

export function secretInitialState(initialValue = ""): SecretPanelState {
  const buffer = new SecretBuffer();
  const cursor = buffer.insert(sanitizeSecretInput(initialValue), 0);
  return { buffer, cursor };
}

/** Pasted bytes reach the buffer stripped of escapes and line breaks. */
export function sanitizeSecretInput(text: string): string {
  return stripAnsi(text).replace(/[\r\n\t]+/g, "");
}

export interface SecretKeyInput {
  readonly state: SecretPanelState;
  readonly chord: string;
  readonly text?: string | undefined;
}

export function secretKey(input: SecretKeyInput): PanelKeyResult<SecretPanelState> {
  const { state, chord } = input;
  if (chord === "enter") {
    return handled(state, { kind: "secret", value: state.buffer.reveal() });
  }
  if (chord === "escape") {
    state.buffer.clear();
    return handled({ ...state, cursor: 0 }, { kind: "secret", value: undefined });
  }
  if (chord === "backspace") {
    return handled({ ...state, cursor: state.buffer.deleteBackward(state.cursor) });
  }
  if (chord === "ctrl+u") {
    state.buffer.clear();
    return handled({ ...state, cursor: 0 });
  }
  if (isPrintable(chord, input.text)) {
    const clean = sanitizeSecretInput(input.text ?? "");
    if (clean.length === 0) return handled(state);
    return handled({ ...state, cursor: state.buffer.insert(clean, state.cursor) });
  }
  return handled(state);
}

export function secretPaste(state: SecretPanelState, text: string): SecretPanelState {
  const clean = sanitizeSecretInput(text);
  if (clean.length === 0) return state;
  return { ...state, cursor: state.buffer.insert(clean, state.cursor) };
}

export interface SecretViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly request: SecretRequestView;
  readonly state: SecretPanelState;
}

export function secretRowsWanted(input: SecretViewInput): number {
  return secretBody(input).length + 2;
}

function secretBody(input: SecretViewInput): readonly string[] {
  const { ink, state } = input;
  const width = panelBodyWidth(input.columns);
  const prompt = wrapWithPrefixes(input.request.prompt.replace(/\r/g, "").trim(), {
    width,
  });
  const value =
    input.request.reveal === true ? state.buffer.reveal() : state.buffer.masked();
  const field = sealStyle(
    `${ink.fg("inputBorder", ink.glyphs.promptMark)} ${clipToWidth(
      value,
      Math.max(1, width - 2),
      ink.glyphs.ellipsis,
    )}`,
  );
  return [...prompt, field];
}

export function secretView(input: SecretViewInput): PanelFrameInput {
  const { ink } = input;
  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: `${ink.glyphs.lock} ${input.request.title}`,
    borderColor: "magenta",
    hints: [`${ink.glyphs.enter} submit`, "esc cancel"],
    body: secretBody(input),
  };
}
