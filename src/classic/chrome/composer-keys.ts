import {
  deleteBackward,
  deleteForward,
  deleteLine,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  deleteWordForward,
  moveBufferEnd,
  moveBufferStart,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveWordLeft,
  moveWordRight,
  type EditorState,
} from "./editor-model.js";
import { moveVisual } from "./editor-view.js";

export type EditorEdit = (state: EditorState, width: number) => EditorState;

const EDITS: Readonly<Record<string, EditorEdit>> = {
  left: (state) => moveLeft(state),
  right: (state) => moveRight(state),
  "ctrl+b": (state) => moveLeft(state),
  "ctrl+f": (state) => moveRight(state),
  "alt+left": (state) => moveWordLeft(state),
  "alt+right": (state) => moveWordRight(state),
  "ctrl+left": (state) => moveWordLeft(state),
  "ctrl+right": (state) => moveWordRight(state),
  "alt+b": (state) => moveWordLeft(state),
  "alt+f": (state) => moveWordRight(state),
  home: (state) => moveLineStart(state),
  end: (state) => moveLineEnd(state),
  "ctrl+a": (state) => moveLineStart(state),
  "ctrl+e": (state) => moveLineEnd(state),
  "ctrl+home": (state) => moveBufferStart(state),
  "ctrl+end": (state) => moveBufferEnd(state),
  backspace: (state) => deleteBackward(state),
  delete: (state) => deleteForward(state),
  "alt+backspace": (state) => deleteWordBackward(state),
  "meta+backspace": (state) => deleteWordBackward(state),
  "ctrl+w": (state) => deleteWordBackward(state),
  "alt+delete": (state) => deleteWordForward(state),
  "meta+delete": (state) => deleteWordForward(state),
  "alt+d": (state) => deleteWordForward(state),
  "ctrl+backspace": (state) => deleteLine(state),
  "ctrl+delete": (state) => deleteLine(state),
  "ctrl+meta+backspace": (state) => deleteLine(state),
  "super+backspace": (state) => deleteLine(state),
  "super+delete": (state) => deleteLine(state),
  "ctrl+u": (state) => deleteLine(state),
  "meta+u": (state) => deleteLine(state),
  "ctrl+k": (state) => deleteToLineEnd(state),
  "shift+up": (state, width) => moveVisual(state, width, -1),
  "shift+down": (state, width) => moveVisual(state, width, 1),
};

export function editorEditFor(chord: string): EditorEdit | undefined {
  return EDITS[chord];
}

export function isEditorChord(chord: string): boolean {
  return chord in EDITS;
}
