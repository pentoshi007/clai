import { describe, expect, it } from "vitest";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { applyAppEvent } from "../../../src/tui-v2/state/transcript-reducer.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/tui-v2/state/transcript-types.js";
import { findMatches, nextMatchIndex, prevMatchIndex } from "../../../src/tui-v2/state/transcript-search.js";

function buildState() {
  const seq = new EventSequencer(asSessionId("s1"));
  let state = EMPTY_TRANSCRIPT_STATE;
  state = applyAppEvent(state, seq.build("turn-started", { prompt: "find the bug in bug.ts" }, undefined));
  state = applyAppEvent(
    state,
    seq.build("assistant-message", { messageId: seq.ids.message(), text: "The Bug is on line 3." }, undefined),
  );
  state = applyAppEvent(state, seq.build("notice", { level: "info", text: "no bugs elsewhere" }, undefined));
  return state;
}

describe("transcript search (V2-057)", () => {
  it("is empty for a blank query", () => {
    expect(findMatches(buildState(), "")).toEqual([]);
    expect(findMatches(buildState(), "   ")).toEqual([]);
  });

  it("matches case-insensitively across items, including repeats within one item", () => {
    const matches = findMatches(buildState(), "bug");
    // user: "bug" (in "the bug") + "bug" (in "bug.ts") = 2
    // assistant: "Bug" = 1
    // notice: "bugs" contains "bug" = 1
    expect(matches).toHaveLength(4);
    expect(new Set(matches.map((m) => m.itemId)).size).toBe(3);
  });

  it("navigates forward and backward with wraparound", () => {
    const matches = findMatches(buildState(), "bug");
    expect(nextMatchIndex(matches, -1)).toBe(0);
    expect(nextMatchIndex(matches, matches.length - 1)).toBe(0);
    expect(prevMatchIndex(matches, 0)).toBe(matches.length - 1);
  });

  it("returns -1 for navigation with no matches", () => {
    expect(nextMatchIndex([], -1)).toBe(-1);
    expect(prevMatchIndex([], -1)).toBe(-1);
  });
});
