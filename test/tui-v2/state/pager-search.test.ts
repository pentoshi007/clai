import { describe, expect, it } from "vitest";
import {
  findPagerMatches,
  nextPagerMatch,
  prevPagerMatch,
  segmentPagerLine,
} from "../../../src/tui-v2/state/pager-search.js";

describe("pager-search (PICK-003)", () => {
  it("finds every case-insensitive match with line/column positions", () => {
    const lines = ["alpha BETA", "gamma alpha"];
    const matches = findPagerMatches(lines, "alpha");
    expect(matches).toEqual([
      { line: 0, column: 0, length: 5 },
      { line: 1, column: 6, length: 5 },
    ]);
  });

  it("finds multiple matches within one line", () => {
    const matches = findPagerMatches(["one one one"], "one");
    expect(matches.map((m) => m.column)).toEqual([0, 4, 8]);
  });

  it("returns no matches for an empty query", () => {
    expect(findPagerMatches(["anything"], "")).toEqual([]);
    expect(findPagerMatches(["anything"], "   ")).toEqual([]);
  });

  it("wraps forward and backward, and reports -1 for no matches", () => {
    const matches = findPagerMatches(["a", "b", "c"], "z");
    expect(nextPagerMatch(matches, -1)).toBe(-1);
    expect(prevPagerMatch(matches, -1)).toBe(-1);

    const real = findPagerMatches(["x", "x", "x"], "x");
    expect(nextPagerMatch(real, 2)).toBe(0);
    expect(prevPagerMatch(real, 0)).toBe(2);
  });
});

describe("segmentPagerLine (match highlighting)", () => {
  it("marks only the matched substring, with the active hit distinct", () => {
    const line = "hello world hello";
    const matches = findPagerMatches([line], "hello");
    expect(matches).toHaveLength(2);

    const segs = segmentPagerLine(line, 0, matches, 0);
    expect(segs).toEqual([
      { text: "hello", kind: "active" },
      { text: " world ", kind: "plain" },
      { text: "hello", kind: "match" },
    ]);

    const next = segmentPagerLine(line, 0, matches, 1);
    expect(next[0]?.kind).toBe("match");
    expect(next[2]?.kind).toBe("active");
  });

  it("returns a single plain segment when the line has no hits", () => {
    const matches = findPagerMatches(["alpha", "beta"], "alpha");
    expect(segmentPagerLine("beta", 1, matches, 0)).toEqual([
      { text: "beta", kind: "plain" },
    ]);
  });

  it("preserves original casing in the painted text", () => {
    const line = "Foo BAR foo";
    const matches = findPagerMatches([line], "foo");
    const segs = segmentPagerLine(line, 0, matches, 0);
    expect(segs.map((s) => s.text).join("")).toBe(line);
    expect(segs.filter((s) => s.kind !== "plain").map((s) => s.text)).toEqual([
      "Foo",
      "foo",
    ]);
  });
});
