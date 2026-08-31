import type { TextEditorRequest } from "../../ui-core/controllers/overlay-controller.js";
import type { InkTheme } from "../render/ink-theme.js";
import { stripAnsi } from "../render/measure.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { editorEditFor } from "../chrome/composer-keys.js";
import {
  EMPTY_EDITOR,
  caretPosition,
  insert,
  logicalLines,
  type EditorState,
} from "../chrome/editor-model.js";
import {
  layoutEditor,
  moveVisual,
  renderEditor,
  scrollTop,
} from "../chrome/editor-view.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";
import { isPrintable } from "./picker-panel.js";

export interface TextEditorPanelState {
  readonly editor: EditorState;
  readonly top: number;
}

export function textEditorInitialState(
  request?: TextEditorRequest,
): TextEditorPanelState {
  const text = sanitizeEditorInput(request?.initialValue ?? "");
  return { editor: { text, cursor: text.length }, top: 0 };
}

export function sanitizeEditorInput(text: string): string {
  return stripAnsi(text).replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
}

function bodyRows(rows: number): number {
  return Math.max(3, panelBodyHeight(rows) - 3);
}

export interface TextEditorKeyInput {
  readonly state: TextEditorPanelState;
  readonly chord: string;
  readonly text?: string | undefined;
  readonly columns: number;
  readonly rows: number;
}

export function textEditorKey(
  input: TextEditorKeyInput,
): PanelKeyResult<TextEditorPanelState> {
  const { state, chord } = input;
  const width = panelBodyWidth(input.columns);

  if (chord === "escape") {
    return handled(state, { kind: "text-editor", value: undefined });
  }
  if (chord === "ctrl+s" || chord === "ctrl+enter" || chord === "meta+enter") {
    return handled(state, {
      kind: "text-editor",
      value: state.editor.text,
    });
  }
  if (chord === "enter" || chord === "shift+enter") {
    return handled(commit(state, insert(state.editor, "\n"), input));
  }
  if (chord === "up" || chord === "down") {
    const next = moveVisual(state.editor, width, chord === "up" ? -1 : 1);
    return handled(commit(state, next, input));
  }
  if (chord === "ctrl+r") {
    return handled(commit(state, EMPTY_EDITOR, input));
  }
  const edit = editorEditFor(chord);
  if (edit) {
    return handled(commit(state, edit(state.editor, width), input));
  }
  if (isPrintable(chord, input.text)) {
    const clean = sanitizeEditorInput(input.text ?? "");
    if (clean.length === 0) return handled(state);
    return handled(commit(state, insert(state.editor, clean), input));
  }
  return unhandled(state);
}

export function textEditorPaste(
  state: TextEditorPanelState,
  text: string,
  view: { columns: number; rows: number },
): TextEditorPanelState {
  const clean = sanitizeEditorInput(text);
  if (clean.length === 0) return state;
  return commit(state, insert(state.editor, clean), view);
}

function commit(
  state: TextEditorPanelState,
  editor: EditorState,
  view: { columns: number; rows: number },
): TextEditorPanelState {
  const layout = layoutEditor(editor, panelBodyWidth(view.columns));
  return { editor, top: scrollTop(layout, bodyRows(view.rows), state.top) };
}

export interface TextEditorViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly request: TextEditorRequest;
  readonly state: TextEditorPanelState;
  readonly showCaret?: boolean | undefined;
}

export function textEditorView(input: TextEditorViewInput): PanelFrameInput {
  const { ink, state, request } = input;
  const width = panelBodyWidth(input.columns);
  const height = bodyRows(input.rows);
  const layout = layoutEditor(state.editor, width);
  const top = scrollTop(layout, height, state.top);
  const rendered = renderEditor({
    state: state.editor,
    layout,
    ink,
    height,
    scrollTop: top,
    showCaret: input.showCaret !== false,
    placeholder:
      state.editor.text.length === 0 ? (request.placeholder ?? "") : undefined,
  });
  const prompt = wrapWithPrefixes(request.prompt.replace(/\r/g, "").trim(), {
    width,
  });
  const caret = caretPosition(state.editor);
  const lines = logicalLines(state.editor.text).length;
  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: request.title,
    borderColor: "modalBorder",
    counter: `ln ${caret.line + 1}/${lines} · col ${caret.column + 1}`,
    hints: [
      `^S ${request.submitLabel ?? "save"}`,
      `${ink.glyphs.enter} newline`,
      "arrows move",
      "^R clear",
      "esc cancel",
    ],
    body: [...prompt.slice(0, 2), ...rendered.rows],
  };
}
