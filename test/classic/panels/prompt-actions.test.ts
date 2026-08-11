import { describe, expect, it, vi } from "vitest";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import {
  promptActionsKey,
  promptActionsView,
  promptLines,
  PROMPT_ACTIONS_INITIAL_STATE,
} from "../../../src/classic/panels/prompt-actions-panel.js";
import { createHarness, ink, rowsOf } from "./harness.js";

const PROMPT =
  "add pagination to the users endpoint and return metadata in the response body";

function request(prompt = PROMPT) {
  return { prompt, onResend: vi.fn() };
}

function render(prompt = PROMPT, state = PROMPT_ACTIONS_INITIAL_STATE, rows = 5) {
  const frame = promptActionsView({ ink, columns: 60, rows, request: request(prompt), state });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

describe("prompt actions rows", () => {
  it("wraps the prompt inside the frame", () => {
    const { frame, rows } = render();
    expect(frame.title).toBe("Prompt");
    expect(rows[1]).toContain("add pagination to the users endpoint");
    // With panelBodyWidth 56, "metadata" stays on the first body line; second line is the tail.
    expect(rows[1]).toContain("metadata");
    expect(rows[2]).toContain("in the response body");
  });

  it("lists the action hints", () => {
    expect(render().frame.hints).toEqual(["c copy", "r resend", "e edit", "esc close"]);
  });

  it("counts windowed rows when the prompt is longer than the body", () => {
    const long = Array.from({ length: 12 }, (_, index) => `row ${index}`).join("\n");
    const { frame } = render(long, PROMPT_ACTIONS_INITIAL_STATE, 5);
    expect(promptLines(long, 60)).toHaveLength(12);
    expect(frame.counter).toBe("1/12");
  });

  it("scrolls the body without moving the frame", () => {
    const long = Array.from({ length: 12 }, (_, index) => `row ${index}`).join("\n");
    const scrolled = promptActionsKey({
      state: PROMPT_ACTIONS_INITIAL_STATE,
      chord: "down",
      request: request(long),
      lineCount: 12,
      rows: 5,
    });
    const { rows } = render(long, scrolled.state, 5);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toContain("row 1");
  });
});

describe("prompt actions keys", () => {
  it("copies and closes on c", async () => {
    const harness = createHarness();
    harness.overlay.openPromptActions(request());
    expect(harness.press("c")).toBe(true);
    await Promise.resolve();
    expect(harness.copied).toEqual([PROMPT]);
    expect(harness.overlay.isOpen()).toBe(false);
  });

  it("resends on r after closing", () => {
    const harness = createHarness();
    const req = request();
    harness.overlay.openPromptActions(req);
    expect(harness.press("r")).toBe(true);
    expect(req.onResend).toHaveBeenCalledTimes(1);
    expect(harness.overlay.isOpen()).toBe(false);
  });

  it("hands the prompt back to the composer on e", () => {
    const harness = createHarness();
    harness.overlay.openPromptActions(request());
    expect(harness.press("e")).toBe(true);
    expect(harness.edited).toEqual([PROMPT]);
    expect(harness.overlay.isOpen()).toBe(false);
  });

  it("leaves unknown chords to the router", () => {
    const harness = createHarness();
    harness.overlay.openPromptActions(request());
    expect(harness.press("ctrl+g")).toBe(false);
  });
});
