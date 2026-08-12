import { describe, expect, it } from "vitest";
import { MAX_PROVIDER_KEYS } from "../../../src/llm/key-rotation.js";
import type { KeysEditorRequest } from "../../../src/ui-core/controllers/overlay-controller.js";
import {
  keysInitialState,
  keysKey,
  keysRevealed,
  keysRowCount,
  keysView,
  type KeysPanelState,
} from "../../../src/classic/panels/keys-panel.js";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import { createHarness, ink, rowsOf } from "./harness.js";

const REQUEST: KeysEditorRequest = {
  provider: "groq",
  initialKeys: [
    { id: "k1", masked: "gsk_••••••••••••3f9a" },
    { id: "k2", masked: "gsk_••••••••••••7b21" },
  ],
  activeIndex: 0,
};

function render(state: KeysPanelState = keysInitialState(REQUEST), request = REQUEST) {
  const frame = keysView({ ink, columns: 80, rows: 7, request, state });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

function press(state: KeysPanelState, chord: string, text?: string, request = REQUEST) {
  return keysKey({ state, request, chord, text, rows: 7 });
}

describe("keys rows", () => {
  it("marks the sticky rotation key", () => {
    const { rows } = render();
    expect(rows[1]).toContain("★ 1  gsk_••••••••••••3f9a");
    expect(rows[2]).toContain("☆ 2  gsk_••••••••••••7b21");
  });

  it("titles by provider and item label", () => {
    expect(render().frame.title).toBe("groq · API keys");
    expect(
      render(undefined, { ...REQUEST, itemLabel: "endpoint URL" }).frame.title,
    ).toBe("groq · endpoint URLs");
  });

  it("lists the add row and the editor hints", () => {
    const { rows, frame } = render();
    expect(rows[3]).toContain("+ add API key");
    expect(frame.hints).toEqual([
      "⏎ edit",
      "space set active",
      "d disable",
      "^D remove",
      "^S save",
      "^R reset",
    ]);
  });

  it("masks typed secrets and reveals endpoint URLs", () => {
    let state = keysInitialState(REQUEST);
    state = press(state, "enter").state;
    for (const char of "abc") state = press(state, char, char).state;
    expect(render(state).rows[1]).toContain("•••");
    expect(render(state).rows[1]).not.toContain("abc");

    const endpoint: KeysEditorRequest = { ...REQUEST, itemLabel: "endpoint URL" };
    expect(keysRevealed(endpoint)).toBe(true);
    expect(keysRevealed(REQUEST)).toBe(false);
    expect(render(state, endpoint).rows[1]).toContain("abc");
  });

  it("caps the list at MAX_PROVIDER_KEYS", () => {
    const full: KeysPanelState = {
      ...keysInitialState(REQUEST),
      rows: Array.from({ length: MAX_PROVIDER_KEYS }, (_, index) => ({
        slotId: `k${index}`,
        masked: "••••",
        value: "",
        disabled: false,
      })),
    };
    expect(keysRowCount(full)).toBe(MAX_PROVIDER_KEYS);
    expect(render(full).rows.join("\n")).not.toContain("+ add");
  });
});

describe("keys keys", () => {
  it("sets the active key with space", () => {
    let state = keysInitialState(REQUEST);
    state = press(state, "down").state;
    state = press(state, "space").state;
    expect(state.activeIndex).toBe(1);
    expect(render(state).rows[2]).toContain("★ 2");
  });

  it("never makes the add row active", () => {
    let state = keysInitialState(REQUEST);
    state = press(state, "up").state;
    expect(press(state, "space").state.activeIndex).toBe(0);
  });

  it("toggles a row disabled with d", () => {
    let state = keysInitialState(REQUEST);
    state = press(state, "d").state;
    expect(state.rows[0]!.disabled).toBe(true);
    expect(render(state).rows[1]).toContain("· disabled");
    state = press(state, "d").state;
    expect(state.rows[0]!.disabled).toBe(false);
    expect(render(state).rows[1]).not.toContain("· disabled");
  });

  it("removes a row and keeps the active index in range", () => {
    let state: KeysPanelState = { ...keysInitialState(REQUEST), cursor: 1, activeIndex: 1 };
    state = press(state, "ctrl+d").state;
    expect(state.rows).toHaveLength(1);
    expect(state.activeIndex).toBe(0);
  });

  it("saves kept, replaced, and new rows", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openKeysEditor(REQUEST);
    harness.press("up");
    harness.press("enter");
    for (const char of "gsk_new") harness.press(char, char);
    harness.press("enter");
    harness.press("ctrl+s");
    await expect(answer).resolves.toEqual({
      action: "save",
      rows: [
        { slotId: "k1", value: "", disabled: false },
        { slotId: "k2", value: "", disabled: false },
        { value: "gsk_new", disabled: false },
      ],
      activeIndex: 0,
    });
  });

  it("resets every key with ctrl+r", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openKeysEditor(REQUEST);
    harness.press("ctrl+r");
    await expect(answer).resolves.toEqual({ action: "reset" });
  });

  it("leaves unknown chords to the router", () => {
    expect(press(keysInitialState(REQUEST), "ctrl+g").handled).toBe(false);
  });
});
