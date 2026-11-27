import { describe, expect, it } from "vitest";
import type { QuestionRequest } from "../../src/app/ports/question-port.js";
import { FocusController } from "../../src/ui-core/controllers/focus-controller.js";
import { OverlayController } from "../../src/ui-core/controllers/overlay-controller.js";
import {
  questionFlowInitialState,
  questionFlowKey,
  questionFlowPaste,
  type QuestionFlowOutcome,
  type QuestionFlowState,
} from "../../src/ui-core/question/question-flow.js";

const request: QuestionRequest = {
  questions: [
    { question: "Database?", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false },
    { question: "Features?", options: [{ label: "Search" }, { label: "Export" }, { label: "Audit" }], multiSelect: true },
  ],
};

const state = (outcome: QuestionFlowOutcome | undefined): QuestionFlowState => {
  if (outcome?.kind !== "continue") throw new Error(`expected continue, got ${outcome?.kind}`);
  return outcome.state;
};

const type = (start: QuestionFlowState, text: string): QuestionFlowState =>
  [...text].reduce((current, char) => state(questionFlowKey(request, current, char === " " ? "space" : char, char)), start);

describe("question flow", () => {
  it("picks a single option with a digit and advances to the next question", () => {
    const next = state(questionFlowKey(request, questionFlowInitialState(request), "2"));
    expect(next.index).toBe(1);
    expect(next.selected[0]).toEqual([1]);
  });

  it("toggles multi-select options and submits every answer", () => {
    let current = state(questionFlowKey(request, questionFlowInitialState(request), "enter"));
    current = state(questionFlowKey(request, current, "3"));
    current = state(questionFlowKey(request, current, "down"));
    current = state(questionFlowKey(request, current, "up"));
    current = state(questionFlowKey(request, current, "up"));
    current = state(questionFlowKey(request, current, "space"));
    expect(current.selected[1]).toEqual([1, 2]);
    expect(questionFlowKey(request, current, "enter")).toEqual({
      kind: "submit",
      answers: [{ selected: ["Postgres"] }, { selected: ["Export", "Audit"] }],
    });
  });

  it("accepts a typed answer that replaces a single choice", () => {
    let current = state(questionFlowKey(request, questionFlowInitialState(request), "1"));
    current = state(questionFlowKey(request, current, "left"));
    expect(current.index).toBe(0);
    current = state(questionFlowKey(request, current, "3"));
    expect(current.editing).toBe(true);
    current = type(current, "DuckDB file");
    current = state(questionFlowKey(request, current, "backspace"));
    current = state(questionFlowKey(request, current, "enter"));
    expect(current.index).toBe(1);
    expect(current.selected[0]).toEqual([]);
    expect(current.custom[0]).toBe("DuckDB fil");
  });

  it("leaves editing on escape and cancels from the option list", () => {
    let current = state(questionFlowKey(request, questionFlowInitialState(request), "3"));
    current = state(questionFlowKey(request, current, "escape"));
    expect(current.editing).toBe(false);
    expect(questionFlowKey(request, current, "escape")).toEqual({ kind: "cancel" });
  });

  it("does not advance with tab until the question is answered", () => {
    const initial = questionFlowInitialState(request);
    expect(state(questionFlowKey(request, initial, "tab")).index).toBe(0);
    expect(questionFlowKey(request, initial, "x")).toBeUndefined();
  });

  it("starts a typed answer from pasted text on one line", () => {
    const pasted = questionFlowPaste(request, questionFlowInitialState(request), "use\nlibsql");
    expect(pasted).toMatchObject({ editing: true, cursor: 2, draft: "use libsql" });
  });
});

describe("question overlay", () => {
  it("resolves with the answers and restores focus", async () => {
    const focus = new FocusController("composer");
    const overlay = new OverlayController(focus);
    const pending = overlay.openQuestions(request);
    expect(overlay.getState().kind).toBe("question");
    expect(focus.activeContext()).toBe("modal");
    overlay.answerQuestions([{ selected: ["SQLite"] }, { selected: [] }]);
    await expect(pending).resolves.toEqual([{ selected: ["SQLite"] }, { selected: [] }]);
    expect(overlay.getState().kind).toBe("none");
    expect(focus.activeContext()).toBe("composer");
  });

  it.each([
    ["cancelBlockingPrompt", (overlay: OverlayController) => expect(overlay.cancelBlockingPrompt()).toBe(true)],
    ["close", (overlay: OverlayController) => overlay.close()],
    ["dispose", (overlay: OverlayController) => overlay.dispose()],
  ])("resolves as skipped on %s", async (_name, dismiss) => {
    const overlay = new OverlayController(new FocusController("composer"));
    const pending = overlay.openQuestions(request);
    dismiss(overlay);
    await expect(pending).resolves.toBeUndefined();
  });

  it("resolves as skipped when another overlay is already open", async () => {
    const overlay = new OverlayController(new FocusController("composer"));
    overlay.openJobs();
    await expect(overlay.openQuestions(request)).resolves.toBeUndefined();
  });
});
