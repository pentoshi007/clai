import { describe, expect, it } from "vitest";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import {
  sanitizeEditorInput,
  textEditorInitialState,
  textEditorKey,
  textEditorPaste,
  textEditorView,
  type TextEditorPanelState,
} from "../../../src/classic/panels/text-editor-panel.js";
import { createHarness, ink, rowsOf } from "./harness.js";

const REQUEST = {
  title: "Add MCP server",
  prompt: "Paste one server JSON object",
  placeholder: "{}",
  submitLabel: "add server",
};

const VIEW = { columns: 80, rows: 20 };

function press(
  state: TextEditorPanelState,
  chord: string,
  text?: string,
): ReturnType<typeof textEditorKey> {
  return textEditorKey({ state, chord, ...(text ? { text } : {}), ...VIEW });
}

function type(value: string, from = textEditorInitialState()): TextEditorPanelState {
  let state = from;
  for (const char of value) state = press(state, char, char).state;
  return state;
}

function render(state: TextEditorPanelState, request = REQUEST) {
  const frame = textEditorView({
    ink,
    columns: VIEW.columns,
    rows: VIEW.rows,
    request,
    state,
    showCaret: false,
  });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

describe("classic multiline text editor panel", () => {
  it("keeps newlines from typing and pasting, unlike the secret prompt", () => {
    let state = type('{"servers": {');
    state = press(state, "enter").state;
    state = type('  "docs": {}', state);
    expect(state.editor.text).toBe('{"servers": {\n  "docs": {}');

    state = textEditorPaste(state, "\r\n}\r\n}\t", VIEW);
    expect(state.editor.text).toBe('{"servers": {\n  "docs": {}\n}\n}  ');
    expect(sanitizeEditorInput("a\r\nb\tc")).toBe("a\nb  c");
  });

  it("moves the caret with arrows and edits in the middle of the text", () => {
    let state = type("abcd");
    expect(state.editor.cursor).toBe(4);
    state = press(state, "left").state;
    state = press(state, "left").state;
    expect(state.editor.cursor).toBe(2);
    state = type("XY", state);
    expect(state.editor.text).toBe("abXYcd");
    state = press(state, "backspace").state;
    expect(state.editor.text).toBe("abXcd");
    state = press(state, "delete").state;
    expect(state.editor.text).toBe("abXd");
    state = press(state, "home").state;
    expect(state.editor.cursor).toBe(0);
    state = press(state, "end").state;
    expect(state.editor.cursor).toBe(4);
    state = press(state, "ctrl+u").state;
    expect(state.editor.text).toBe("");
  });

  it("walks lines with up/down instead of prompt history", () => {
    let state = type("one");
    state = press(state, "enter").state;
    state = type("two", state);
    state = press(state, "up").state;
    expect(state.editor.cursor).toBeLessThanOrEqual(3);
    state = press(state, "down").state;
    expect(state.editor.cursor).toBeGreaterThan(3);
  });

  it("saves with ctrl+s and cancels with escape", () => {
    const state = type('{"a":1}');
    expect(press(state, "ctrl+s").effects).toEqual([
      { kind: "text-editor", value: '{"a":1}' },
    ]);
    expect(press(state, "escape").effects).toEqual([
      { kind: "text-editor", value: undefined },
    ]);
    expect(press(state, "ctrl+r").state.editor.text).toBe("");
  });

  it("shows the caret position, every line, and the editing hints", () => {
    let state = type("line one");
    state = press(state, "enter").state;
    state = type("line two", state);
    const { frame, rows } = render(state);
    expect(frame.counter).toBe("ln 2/2 · col 9");
    expect(frame.hints?.[0]).toBe("^S add server");
    expect(frame.hints).toContain("arrows move");
    expect(rows.join("\n")).toContain("line one");
    expect(rows.join("\n")).toContain("line two");
    expect(rows[1]).toContain("Paste one server JSON object");
  });

  it("routes overlay keys and pastes through the panel controller", () => {
    const harness = createHarness();
    void harness.overlay.openTextEditor(REQUEST);
    expect(harness.panels.getSnapshot().kind).toBe("text-editor");

    expect(harness.press("a", "a")).toBe(true);
    expect(harness.press("enter")).toBe(true);
    expect(harness.press("b", "b")).toBe(true);
    expect(harness.handlePasteThroughPanels("c\nd")).toBe(true);
    expect(harness.panels.getSnapshot().textEditor.editor.text).toBe("a\nbc\nd");

    expect(harness.press("ctrl+s")).toBe(true);
    expect(harness.overlay.getState().kind).toBe("none");
  });

  it("resolves the pending editor when the overlay is closed from outside", async () => {
    const harness = createHarness();
    const pending = harness.overlay.openTextEditor(REQUEST);
    harness.overlay.close();
    await expect(pending).resolves.toBeUndefined();
  });
});
