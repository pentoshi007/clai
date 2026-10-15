import { describe, expect, it } from "vitest";
import { composerCursorAtPointer, type ComposerPointerView } from "../../../src/classic/chrome/composer-pointer.js";
import { layoutEditor, renderCaretRow, renderEditor, scrollTop } from "../../../src/classic/chrome/editor-view.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { boundaries } from "../../../src/classic/chrome/editor-model.js";
import { displayWidth } from "../../../src/classic/render/measure.js";

function view(text: string, width = 20, height = 4, cursor = text.length): ComposerPointerView {
  const state = { text, cursor };
  const layout = layoutEditor(state, width);
  return { state, layout, height, scrollTop: scrollTop(layout, height) };
}

const geometry = { left: 5, top: 10 };
const pointer = (layout: ComposerPointerView, column: number, row = 0) => composerCursorAtPointer(layout, geometry, geometry.left + column, geometry.top + row);

describe("composer pointer grapheme geometry", () => {
  it.each(["a界🙂z", "a👨‍👩‍👧‍👦z", "ae\u0301z", "a🏳️‍🌈z"])("snaps every visible cell to a grapheme boundary in %s", (text) => {
    const layout = view(text, 60);
    const bounds = boundaries(text);
    let column = 0;
    for (let i = 1; i < bounds.length; i += 1) {
      const start = bounds[i - 1]!;
      const width = displayWidth(text.slice(start, bounds[i]!));
      for (let cell = 0; cell < width; cell += 1) expect(pointer(layout, column + cell)).toBe(start);
      column += width;
    }
    expect(pointer(layout, column)).toBe(text.length);
  });

  it.each(["a👨‍👩‍👧‍👦界Z", "a界👨‍👩‍👧‍👦界Z", "e\u0301👨‍👩‍👧‍👦界Z"])("paints the clicked caret over the intended cell in mixed-width %s", (text) => {
    const pointerView = view(text, 60);
    const cursor = pointer(pointerView, displayWidth(text.slice(0, -1)))!;
    expect(cursor).toBe(text.length - 1);
    const state = { text, cursor };
    const layout = layoutEditor(state, 60);
    const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
    expect(renderCaretRow(ink, text, layout.caretColumn, true)).toContain(ink.inverse("Z"));
    expect(renderEditor({ state, layout, ink, height: 1, scrollTop: 0, showCaret: true, placeholder: undefined }).rows[0]).toContain(ink.inverse("Z"));
  });

  it("respects soft wraps, hard breaks, empty rows and visible vertical offsets", () => {
    const layout = view("abcdefgh\n\nlast row", 4, 2);
    expect(layout.scrollTop).toBeGreaterThan(0);
    for (let row = 0; row < layout.height; row += 1) {
      const visual = layout.layout.rows[layout.scrollTop + row]!;
      expect(pointer(layout, 0, row)).toBe(visual.start);
      expect(pointer(layout, 4, row)).toBe(visual.end);
    }
    const empty = view("abc\n\nlast", 20, 4, 0);
    expect(pointer(empty, 4, 1)).toBe(4);
    expect(pointer(empty, -1)).toBe(0);
    expect(pointer(empty, 10, 3)).toBe(empty.state.text.length);
  });

  it("rejects coordinates outside the composer text rows and shell borders", () => {
    const layout = view("abc");
    expect(pointer(layout, -3)).toBeUndefined();
    expect(pointer(layout, 21)).toBeUndefined();
    expect(pointer(layout, 0, -1)).toBeUndefined();
    expect(pointer(layout, 0, 4)).toBeUndefined();
  });

  it("uses the new visual row boundaries after width changes", () => {
    const text = "abcdefghijklmno";
    expect(pointer(view(text, 5, 3, 0), 2, 1)).toBe(7);
    expect(pointer(view(text, 10, 3, 0), 2, 1)).toBe(12);
  });
});
