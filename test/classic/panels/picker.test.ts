import { describe, expect, it, vi } from "vitest";
import type { PickerRequest } from "../../../src/ui-core/controllers/overlay-controller.js";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import {
  pickerInitialState,
  pickerKey,
  pickerView,
} from "../../../src/classic/panels/picker-panel.js";
import { createHarness, ink, rowsOf } from "./harness.js";

const MODELS: PickerRequest = {
  title: "Select model",
  options: [
    { value: "kimi-k2-thinking", label: "kimi-k2-thinking", description: "groq · 128k" },
    { value: "kimi-k2-instruct", label: "kimi-k2-instruct", description: "groq · 128k" },
    { value: "gpt-oss-20b", label: "gpt-oss-20b", description: "openrouter", active: true },
  ],
};

function render(request: PickerRequest, state = pickerInitialState(request), columns = 80) {
  const view = pickerView({ ink, columns, rows: 8, request, state });
  return { view, rows: rowsOf(panelFrameRows(view.frame).rows) };
}

describe("picker panel rows", () => {
  it("starts on the active option and titles the frame", () => {
    const { view, rows } = render(MODELS);
    expect(view.frame.title).toBe("Select model");
    expect(view.frame.counter).toBe("3/3");
    expect(rows[0]).toContain("Select model");
    expect(rows[3]).toContain("❯ gpt-oss-20b");
    expect(rows[3]).toContain("current");
  });

  it("shows the filter row only after the user types", () => {
    expect(render(MODELS).rows.some((row) => row.includes("filter:"))).toBe(false);
    const typed = pickerKey({ request: MODELS, state: pickerInitialState(MODELS), chord: "k", text: "k", rows: 8 });
    expect(typed.handled).toBe(true);
    const { rows } = render(MODELS, typed.state);
    expect(rows[1]).toContain("filter: k");
  });

  it("reuses the shared matcher and reports an empty result", () => {
    const state = { query: "zzzz", cursor: 0, top: 0 };
    const { view, rows } = render(MODELS, state);
    expect(view.count).toBe(0);
    expect(view.frame.counter).toBeUndefined();
    expect(rows.some((row) => row.includes("no matches"))).toBe(true);
    expect(rows[rows.length - 1]).toContain("esc cancel");
  });

  it("drops descriptions below 68 columns", () => {
    expect(render(MODELS, pickerInitialState(MODELS), 80).rows[1]).toContain("groq");
    expect(render(MODELS, pickerInitialState(MODELS), 44).rows[1]).not.toContain("groq");
  });

  it("puts the description on its own row for twoLine requests", () => {
    const request: PickerRequest = { ...MODELS, twoLine: true };
    const { rows } = render(request, { query: "", cursor: 0, top: 0 });
    expect(rows[1]).toContain("kimi-k2-thinking");
    expect(rows[2]).toContain("groq · 128k");
    expect(rows[2]).not.toContain("kimi");
  });

  it("keeps the active row visible when the list is longer than the body", () => {
    const request: PickerRequest = {
      title: "Big",
      options: Array.from({ length: 40 }, (_, index) => ({
        value: `v${index}`,
        label: `option-${index}`,
      })),
    };
    let state = pickerInitialState(request);
    for (let i = 0; i < 30; i += 1) {
      state = pickerKey({ request, state, chord: "down", rows: 8 }).state;
    }
    const { view, rows } = render(request, state);
    expect(view.frame.counter).toBe("31/40");
    expect(rows.some((row) => row.includes("❯ option-30"))).toBe(true);
  });

  it("appends the row-action hint", () => {
    const request: PickerRequest = {
      ...MODELS,
      historyStyle: true,
      rowAction: { chord: "ctrl+d", hint: "^D delete" },
    };
    const { rows } = render(request);
    expect(rows[rows.length - 1]).toContain("^D delete");
    expect(rows[rows.length - 1]).toContain("⏎ resume");
  });
});

describe("picker panel keys", () => {
  it("selects through the overlay controller", () => {
    const harness = createHarness();
    const onSelect = vi.fn();
    harness.overlay.openPicker(MODELS, onSelect);
    expect(harness.press("down")).toBe(true);
    expect(harness.press("enter")).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("dispatches the row action through actOnPickerRow", () => {
    const harness = createHarness();
    const onRowAction = vi.fn();
    harness.overlay.openPicker(
      { ...MODELS, rowAction: { chord: "ctrl+d", hint: "^D delete" } },
      vi.fn(),
      onRowAction,
    );
    expect(harness.press("ctrl+d")).toBe(true);
    expect(onRowAction).toHaveBeenCalledWith("gpt-oss-20b");
  });

  it("edits the filter with backspace and ctrl+u", () => {
    const harness = createHarness();
    harness.overlay.openPicker(MODELS, vi.fn());
    harness.press("k", "k");
    harness.press("i", "i");
    expect(harness.panels.getSnapshot().picker.query).toBe("ki");
    harness.press("backspace");
    expect(harness.panels.getSnapshot().picker.query).toBe("k");
    harness.press("ctrl+u");
    expect(harness.panels.getSnapshot().picker.query).toBe("");
  });

  it("leaves unknown chords to the router", () => {
    const harness = createHarness();
    harness.overlay.openPicker(MODELS, vi.fn());
    expect(harness.press("ctrl+g")).toBe(false);
  });
});
