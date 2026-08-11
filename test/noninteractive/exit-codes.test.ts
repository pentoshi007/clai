import { describe, expect, it } from "vitest";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import {
  exitCodeForError,
  exitCodeForOutcome,
} from "../../src/noninteractive/start-noninteractive.js";

describe("noninteractive exit codes", () => {
  it("returns zero for completed and soft-failed turns", () => {
    for (const status of ["succeeded", "partial", "blocked", "failed", "paused_budget"] as const) {
      expect(
        exitCodeForOutcome(
          createTurnOutcome({
            status,
            answer: "result",
            steps: 1,
            remainingCriteria: status === "succeeded" ? [] : ["follow up"],
          }),
        ),
      ).toBe(0);
    }
  });

  it("returns 130 for an aborted turn", () => {
    expect(
      exitCodeForOutcome(
        createTurnOutcome({
          status: "aborted",
          answer: "",
          steps: 0,
          remainingCriteria: [],
        }),
      ),
    ).toBe(130);
  });

  it("returns one for unhandled and loader errors", () => {
    expect(exitCodeForError(new Error("provider unavailable"))).toBe(1);
    expect(exitCodeForError(new Error("loader failed"))).toBe(1);
  });
});
