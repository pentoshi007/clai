import { describe, expect, it } from "vitest";
import { editorEditFor, isEditorChord } from "../../../src/classic/chrome/composer-keys.js";
import {
  boundaries,
  caretPosition,
  deleteBackward,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  deleteWordForward,
  EMPTY_EDITOR,
  insert,
  moveBufferEnd,
  moveBufferStart,
  moveLeft,
  moveLine,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveWordLeft,
  moveWordRight,
  normalize,
  replaceRange,
  setText,
  type EditorState,
} from "../../../src/classic/chrome/editor-model.js";
import { layoutEditor, moveVisual, renderCaretRow, renderEditor, scrollTop } from "../../../src/classic/chrome/editor-view.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth } from "../../../src/classic/render/measure.js";

const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

function at(text: string, cursor: number): EditorState {
  return { text, cursor };
}

const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
const plainInk = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: true });

describe("grapheme boundaries", () => {
  it("treats a ZWJ emoji family as one grapheme", () => {
    expect(boundaries(FAMILY)).toEqual([0, FAMILY.length]);
  });

  it("includes both ends for plain text", () => {
    expect(boundaries("abc")).toEqual([0, 1, 2, 3]);
  });

  it("returns a single boundary for empty text", () => {
    expect(boundaries("")).toEqual([0]);
  });
});

describe("cursor movement", () => {
  it("steps over a ZWJ family in one press", () => {
    const start = at(FAMILY, 0);
    expect(moveRight(start).cursor).toBe(FAMILY.length);
    expect(moveLeft(at(FAMILY, FAMILY.length)).cursor).toBe(0);
  });

  it("clamps at both ends", () => {
    expect(moveLeft(at("ab", 0)).cursor).toBe(0);
    expect(moveRight(at("ab", 2)).cursor).toBe(2);
  });

  it("snaps a mid-grapheme cursor back to a boundary", () => {
    expect(normalize(at(FAMILY, 3)).cursor).toBe(0);
  });

  it("moves by word in both directions", () => {
    const text = "const value = 1;";
    expect(moveWordLeft(at(text, text.length)).cursor).toBe(text.indexOf("1"));
    expect(moveWordRight(at(text, 0)).cursor).toBe("const".length);
  });

  it("honours line and buffer anchors", () => {
    const text = "one\ntwo\nthree";
    expect(moveLineStart(at(text, 5)).cursor).toBe(4);
    expect(moveLineEnd(at(text, 5)).cursor).toBe(7);
    expect(moveBufferStart(at(text, 5)).cursor).toBe(0);
    expect(moveBufferEnd(at(text, 5)).cursor).toBe(text.length);
  });

  it("keeps the column when walking logical lines", () => {
    const text = "abcdef\nab\nabcdef";
    const state = moveLine(at(text, 4), 1);
    expect(caretPosition(state)).toEqual({ line: 1, column: 2 });
    expect(moveLine(state, 1)).toEqual(at(text, 12));
  });

  it("refuses to leave the buffer by line", () => {
    const text = "one\ntwo";
    expect(moveLine(at(text, 0), -1).cursor).toBe(0);
    expect(moveLine(at(text, 5), 1).cursor).toBe(5);
  });
});

describe("editing", () => {
  it("inserts at the cursor and advances past the insertion", () => {
    expect(insert(at("ac", 1), "b")).toEqual(at("abc", 2));
  });

  it("deletes a whole grapheme in each direction", () => {
    expect(deleteBackward(at(`a${FAMILY}`, 1 + FAMILY.length))).toEqual(at("a", 1));
    expect(deleteForward(at(`${FAMILY}a`, 0))).toEqual(at("a", 0));
  });

  it("is a no-op at the buffer edges", () => {
    expect(deleteBackward(EMPTY_EDITOR)).toBe(EMPTY_EDITOR);
    expect(deleteForward(at("a", 1))).toEqual(at("a", 1));
  });

  it("deletes by word", () => {
    expect(deleteWordBackward(at("one two", 7))).toEqual(at("one ", 4));
    expect(deleteWordForward(at("one two", 0))).toEqual(at(" two", 0));
  });

  it("kills to the line edges without crossing the newline", () => {
    expect(deleteToLineStart(at("one\ntwo", 6))).toEqual(at("one\no", 4));
    expect(deleteToLineEnd(at("one\ntwo", 5))).toEqual(at("one\nt", 5));
  });

  it("replaces a range and clamps out-of-range offsets", () => {
    expect(replaceRange(at("abcdef", 0), 1, 3, "X")).toEqual(at("aXdef", 2));
    expect(replaceRange(at("ab", 0), 5, 9, "X")).toEqual(at("abX", 3));
  });

  it("clamps the cursor when text shrinks", () => {
    expect(setText(at("abcdef", 6), "ab")).toEqual(at("ab", 2));
  });
});

describe("visual layout", () => {
  it("wraps at word boundaries and tracks source offsets", () => {
    const layout = layoutEditor(at("alpha beta gamma", 16), 11);
    expect(layout.rows.map((row) => row.text)).toEqual(["alpha beta ", "gamma"]);
    expect(layout.rows[1]!.start).toBe("alpha beta ".length);
    expect(layout.caretRow).toBe(1);
    expect(layout.caretColumn).toBe(5);
  });

  it("hard-breaks a word with no space in it", () => {
    const layout = layoutEditor(at("abcdefgh", 0), 3);
    expect(layout.rows.map((row) => row.text)).toEqual(["abc", "def", "gh"]);
  });

  it("counts a wide grapheme as two columns", () => {
    const layout = layoutEditor(at("漢字", 4), 3);
    expect(layout.rows.map((row) => row.text)).toEqual(["漢", "字"]);
    expect(layout.caretColumn).toBe(2);
  });

  it("keeps one row per logical line even when empty", () => {
    const layout = layoutEditor(at("a\n\nb", 4), 20);
    expect(layout.rows.map((row) => row.text)).toEqual(["a", "", "b"]);
    expect(layout.rows[1]!.hardBreak).toBe(true);
  });

  it("puts the caret on the wrapped row it belongs to", () => {
    const layout = layoutEditor(at("alpha beta", 6), 6);
    expect(layout.caretRow).toBe(1);
    expect(layout.caretColumn).toBe(0);
  });

  it("moves visually by wrapped row, preserving the column", () => {
    const state = at("alpha beta gamma", 13);
    const up = moveVisual(state, 11, -1);
    expect(layoutEditor(up, 11).caretRow).toBe(0);
    expect(layoutEditor(up, 11).caretColumn).toBe(2);
    expect(moveVisual(up, 11, -1)).toBe(up);
  });
});

describe("scroll window", () => {
  it("follows the caret down and back up", () => {
    const state = at("a\nb\nc\nd\ne", 8);
    const layout = layoutEditor(state, 10);
    expect(scrollTop(layout, 2, 0)).toBe(3);
    const top = layoutEditor(at(state.text, 0), 10);
    expect(scrollTop(top, 2, 3)).toBe(0);
  });

  it("never scrolls past the last row", () => {
    const layout = layoutEditor(at("a\nb", 3), 10);
    expect(scrollTop(layout, 5, 9)).toBe(0);
  });
});

describe("rendering", () => {
  it("marks the caret cell inverse and keeps the display width", () => {
    const row = renderCaretRow(ink, "abc", 1, true);
    expect(displayWidth(row)).toBe(3);
    expect(row).not.toBe("abc");
  });

  it("appends a caret cell at end of line", () => {
    expect(displayWidth(renderCaretRow(ink, "ab", 2, true))).toBe(3);
  });

  it("omits the caret when suppressed", () => {
    expect(renderCaretRow(ink, "abc", 1, false)).toBe("abc");
  });

  it("pads to the requested height and reports clipping", () => {
    const state = at("a\nb\nc\nd", 6);
    const layout = layoutEditor(state, 10);
    const rendered = renderEditor({
      state,
      layout,
      ink: plainInk,
      height: 2,
      scrollTop: 1,
      showCaret: true,
      placeholder: undefined,
    });
    expect(rendered.rows).toHaveLength(2);
    expect(rendered.clippedAbove).toBe(true);
    expect(rendered.clippedBelow).toBe(true);
  });

  it("shows the placeholder only for an empty draft", () => {
    const rendered = renderEditor({
      state: EMPTY_EDITOR,
      layout: layoutEditor(EMPTY_EDITOR, 20),
      ink: plainInk,
      height: 2,
      scrollTop: 0,
      showCaret: false,
      placeholder: "Ask anything...",
    });
    expect(rendered.rows[0]).toBe("Ask anything...");
    expect(rendered.rows[1]).toBe("");
  });
});

describe("chord map", () => {
  it("resolves the readline chords the composer owns", () => {
    for (const chord of ["left", "right", "home", "end", "backspace", "delete", "ctrl+w", "ctrl+k", "alt+left"]) {
      expect(isEditorChord(chord)).toBe(true);
    }
  });

  it("leaves globally bound chords to the router", () => {
    for (const chord of ["ctrl+c", "ctrl+d", "ctrl+h", "ctrl+j", "enter", "tab", "shift+tab", "up", "down"]) {
      expect(isEditorChord(chord)).toBe(false);
    }
  });

  it("applies a chord edit through the resolved function", () => {
    const edit = editorEditFor("ctrl+w");
    expect(edit).toBeTypeOf("function");
    expect(edit!(at("one two", 7), 80)).toEqual(at("one ", 4));
  });
});
