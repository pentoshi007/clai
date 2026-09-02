import { describe, expect, it } from "vitest";

import { trimExactContinuationOverlap } from "../../src/agent/turn/continuation-overlap.js";

describe("trimExactContinuationOverlap", () => {
  it("removes a repeated full previous response", () => {
    expect(trimExactContinuationOverlap("alpha beta", "alpha beta gamma")).toBe(" gamma");
  });

  it("removes the longest exact suffix-prefix overlap", () => {
    const overlap = "0123456789abcdefghijklmnopqrstuvwxyz";
    expect(
      trimExactContinuationOverlap(`earlier ${overlap}`, `${overlap} continued`),
    ).toBe(" continued");
  });

  it("retains an overlap below the default minimum", () => {
    const overlap = "1234567890123456789012345678901";
    expect(trimExactContinuationOverlap(`earlier ${overlap}`, `${overlap} continued`)).toBe(
      `${overlap} continued`,
    );
  });

  it("honors an explicit minimum overlap", () => {
    expect(trimExactContinuationOverlap("prefix-abcd", "abcd-tail", 4)).toBe("-tail");
  });

  it("retains unrelated and empty-prefix continuations", () => {
    expect(trimExactContinuationOverlap("previous", "current")).toBe("current");
    expect(trimExactContinuationOverlap("", "current")).toBe("current");
  });
});
