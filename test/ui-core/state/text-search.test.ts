import { describe, expect, it } from "vitest";
import {
  compileSearchQuery,
  findTextRanges,
  hasSearchQuery,
  matchCounterLabel,
  stepMatchIndex,
} from "../../../src/ui-core/state/text-search.js";
import { findPagerMatches, nearestPagerMatch } from "../../../src/ui-core/state/pager-search.js";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { applyAppEvent } from "../../../src/ui-core/state/transcript-reducer.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/ui-core/state/transcript-types.js";
import { findMatches, nearestMatchAtOrBefore } from "../../../src/ui-core/state/transcript-search.js";

describe("shared text search", () => {
  it("treats blank queries as inactive and trims the edges", () => {
    expect(hasSearchQuery("   ")).toBe(false);
    expect(compileSearchQuery(" \t")).toBeUndefined();
    expect(findTextRanges("a needle here", "  needle  ")).toEqual([{ start: 2, end: 8 }]);
  });

  it("keeps offsets in the original text for case changes that alter length", () => {
    const text = "İstanbul and ISTANBUL and istanbul";
    expect(findTextRanges(text, "istanbul").map((range) => text.slice(range.start, range.end))).toEqual(["ISTANBUL", "istanbul"]);
    expect(findTextRanges("ÉCOLE école", "école")).toEqual([{ start: 0, end: 5 }, { start: 6, end: 11 }]);
  });

  it("matches multi-word queries across runs of whitespace and line breaks", () => {
    expect(findTextRanges("open\n   the  file", "open the file")).toEqual([{ start: 0, end: 17 }]);
  });

  it("matches regular expression characters literally", () => {
    expect(findTextRanges("cost $5.00 (approx) [x] a+b", "$5.00 (approx)")).toEqual([{ start: 5, end: 19 }]);
    expect(findTextRanges("a+b", "a+b")).toHaveLength(1);
    expect(findTextRanges("aab", "a+b")).toHaveLength(0);
  });

  it("steps through matches in both directions with wraparound", () => {
    expect(stepMatchIndex(0, -1, 1)).toBe(-1);
    expect(stepMatchIndex(3, -1, 1)).toBe(0);
    expect(stepMatchIndex(3, -1, -1)).toBe(2);
    expect(stepMatchIndex(3, 2, 1)).toBe(0);
    expect(stepMatchIndex(3, 0, -1)).toBe(2);
  });

  it("labels the active match position", () => {
    expect(matchCounterLabel("", 4, 1)).toBe("");
    expect(matchCounterLabel("x", 0, -1)).toBe("no matches");
    expect(matchCounterLabel("x", 1, -1)).toBe("1 match");
    expect(matchCounterLabel("x", 4, -1)).toBe("4 matches");
    expect(matchCounterLabel("x", 4, 1)).toBe("2/4");
  });
});

describe("nearest match selection", () => {
  it("starts pager searches at the first match from the reference line", () => {
    const matches = findPagerMatches(["x", "a", "x b x", "x"], "x");
    expect(nearestPagerMatch(matches, 1)).toBe(1);
    expect(nearestPagerMatch(matches, 2, 1)).toBe(2);
    expect(nearestPagerMatch(matches, 9)).toBe(0);
    expect(nearestPagerMatch([], 0)).toBe(-1);
  });

  it("searches the transcript backwards from the reading position", () => {
    const seq = new EventSequencer(asSessionId("nearest"));
    let state = EMPTY_TRANSCRIPT_STATE;
    for (const text of ["needle one", "nothing", "needle two needle three"]) {
      state = applyAppEvent(state, seq.build("assistant-message", { messageId: seq.ids.message(), text }, undefined));
    }
    const matches = findMatches(state, "needle");
    expect(matches.map((match) => [match.itemIndex, match.occurrence])).toEqual([[0, 0], [2, 0], [2, 1]]);
    expect(nearestMatchAtOrBefore(matches, { itemIndex: 2, start: Number.MAX_SAFE_INTEGER })).toBe(2);
    expect(nearestMatchAtOrBefore(matches, { itemIndex: 2, start: 5 })).toBe(1);
    expect(nearestMatchAtOrBefore(matches, { itemIndex: 1, start: 0 })).toBe(0);
    expect(findMatches(state, "needle", (item) => item.kind !== "assistant")).toEqual([]);
  });
});
