import { describe, expect, it } from "vitest";
import type { QuestionAnswer, QuestionRequest } from "../../../src/app/ports/question-port.js";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import { questionRowsWanted, questionView } from "../../../src/classic/panels/question-panel.js";
import { questionFlowInitialState } from "../../../src/ui-core/question/question-flow.js";
import { createHarness, ink, rowsOf } from "./harness.js";

const request: QuestionRequest = {
  questions: [
    {
      question: "Which auth flow?",
      header: "Auth",
      options: [
        { label: "OAuth (Recommended)", description: "Reuses the identity provider" },
        { label: "Magic link", description: "No passwords" },
      ],
      multiSelect: false,
    },
    { question: "Ship docs?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false },
  ],
};

describe("question panel", () => {
  it("renders the header, counter, options, and a typed-answer row", () => {
    const state = questionFlowInitialState(request);
    const frame = questionView({ ink, columns: 90, rows: 12, request, state });
    const rows = rowsOf(panelFrameRows(frame).rows);
    expect(frame.title).toBe("? Auth");
    expect(frame.counter).toBe("1/2");
    expect(rows.some((row) => row.includes("Which auth flow?"))).toBe(true);
    expect(rows.some((row) => row.includes("1. OAuth (Recommended)") && row.includes("Reuses the identity provider"))).toBe(true);
    expect(rows.some((row) => row.includes("3. Type your own answer…"))).toBe(true);
    expect(frame.hints).toContain("esc skip");
    expect(questionRowsWanted({ columns: 90, request, state })).toBe(7);
  });

  it("shows the active option's description below the list on narrow terminals", () => {
    const state = questionFlowInitialState(request);
    const rows = rowsOf(panelFrameRows(questionView({ ink, columns: 50, rows: 12, request, state })).rows);
    expect(rows.filter((row) => row.includes("Reuses the identity provider"))).toHaveLength(1);
    expect(rows.some((row) => row.includes("1. OAuth (Recommended)") && row.includes("Reuses"))).toBe(false);
    expect(questionRowsWanted({ columns: 50, request, state })).toBe(8);
  });

  it("answers through the panel controller and keeps escape inside the typed answer", async () => {
    const harness = createHarness();
    const pending = harness.overlay.openQuestions(request);
    expect(harness.press("2")).toBe(true);
    expect(harness.press("3")).toBe(true);
    expect(harness.handlePasteThroughPanels("later")).toBe(true);
    expect(harness.panels.handleEscape()).toBe(true);
    expect(harness.panels.getSnapshot().question.editing).toBe(false);
    expect(harness.panels.handleEscape()).toBe(false);
    expect(harness.press("3")).toBe(true);
    expect(harness.handlePasteThroughPanels("later")).toBe(true);
    expect(harness.press("enter")).toBe(true);
    const answers: QuestionAnswer[] = [{ selected: ["Magic link"] }, { selected: [], custom: "later" }];
    await expect(pending).resolves.toEqual(answers);
    expect(harness.overlay.getState().kind).toBe("none");
  });
});
