import { describe, expect, it } from "vitest";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import {
  scopeInitialState,
  scopeKey,
  scopeView,
  type ScopePanelState,
} from "../../../src/classic/panels/scope-panel.js";
import { createHarness, ink, rowsOf } from "./harness.js";

const REQUEST = { initialTargets: ["10.0.0.0/24", "example.com"] };

function render(state: ScopePanelState = scopeInitialState(REQUEST)) {
  const frame = scopeView({ ink, columns: 80, rows: 7, state });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

function press(state: ScopePanelState, chord: string, text?: string) {
  return scopeKey({ state, chord, text, rows: 7 });
}

describe("scope rows", () => {
  it("lists numbered targets and an add row", () => {
    const { frame, rows } = render();
    expect(frame.title).toBe("Engagement scope");
    expect(frame.counter).toBe("1/3");
    expect(rows[1]).toContain("1  10.0.0.0/24");
    expect(rows[1]).toContain("×");
    expect(rows[2]).toContain("2  example.com");
    expect(rows[3]).toContain("3  + add target");
    expect(rows[3]).not.toContain("×");
  });

  it("lists the editor hints", () => {
    expect(render().frame.hints).toEqual([
      "▲▼",
      "⏎ edit",
      "^D remove",
      "^S save",
      "^R clear",
      "esc",
    ]);
  });

  it("shows the draft while editing", () => {
    let state = press(scopeInitialState(REQUEST), "enter").state;
    state = press(state, "backspace").state;
    const { rows } = render(state);
    expect(rows[1]).toContain("1  10.0.0.0/2");
  });
});

describe("scope keys", () => {
  it("adds a target through the add row", () => {
    let state = scopeInitialState({ initialTargets: [] });
    state = press(state, "enter").state;
    for (const char of "10.0.0.1") state = press(state, char, char).state;
    state = press(state, "enter").state;
    expect(state.targets).toEqual(["10.0.0.1"]);
    expect(state.editing).toBe(false);
  });

  it("edits an existing target in place", () => {
    let state = scopeInitialState(REQUEST);
    state = press(state, "down").state;
    state = press(state, "enter").state;
    state = press(state, "ctrl+u").state;
    for (const char of "target.dev") state = press(state, char, char).state;
    state = press(state, "enter").state;
    expect(state.targets).toEqual(["10.0.0.0/24", "target.dev"]);
  });

  it("cancels an edit without changing the list", () => {
    let state = scopeInitialState(REQUEST);
    state = press(state, "enter").state;
    state = press(state, "z", "z").state;
    state = press(state, "escape").state;
    expect(state.targets).toEqual(REQUEST.initialTargets);
    expect(state.editing).toBe(false);
  });

  it("removes with ctrl+d and clears with ctrl+r", () => {
    let state = press(scopeInitialState(REQUEST), "ctrl+d").state;
    expect(state.targets).toEqual(["example.com"]);
    state = press(state, "ctrl+r").state;
    expect(state.targets).toEqual([]);
  });

  it("never removes the add row", () => {
    const state = scopeInitialState({ initialTargets: [] });
    expect(press(state, "ctrl+d").state.targets).toEqual([]);
  });

  it("saves the target list through the overlay", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openScopeEditor(REQUEST);
    expect(harness.press("ctrl+s")).toBe(true);
    await expect(answer).resolves.toEqual(["10.0.0.0/24", "example.com"]);
  });

  it("saves an empty list so scoping can be disabled", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openScopeEditor(REQUEST);
    harness.press("ctrl+r");
    harness.press("ctrl+s");
    await expect(answer).resolves.toEqual([]);
  });

  it("leaves unknown chords to the router", () => {
    expect(press(scopeInitialState(REQUEST), "ctrl+g").handled).toBe(false);
  });
});
