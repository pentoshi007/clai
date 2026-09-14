import { describe, expect, it } from "vitest";
import {
  EFFORT_LADDER,
  fallbackEffortsFor,
} from "../../src/llm/routing/error-classification.js";

describe("fallbackEffortsFor", () => {
  it("descends the full ladder from max", () => {
    expect(fallbackEffortsFor("max")).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });

  it("descends from xhigh", () => {
    expect(fallbackEffortsFor("xhigh")).toEqual([
      "high",
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });

  it("keeps descending below the classic low/medium/high set", () => {
    expect(fallbackEffortsFor("high")).toEqual(["medium", "low", "minimal", "none"]);
    expect(fallbackEffortsFor("medium")).toEqual(["low", "minimal", "none"]);
    expect(fallbackEffortsFor("low")).toEqual(["minimal", "none"]);
  });

  it("can only fall back to disable from minimal", () => {
    expect(fallbackEffortsFor("minimal")).toEqual(["none"]);
    expect(fallbackEffortsFor("none")).toEqual([]);
  });

  it("never includes the requested effort itself", () => {
    for (const effort of EFFORT_LADDER) {
      expect(fallbackEffortsFor(effort)).not.toContain(effort);
    }
  });
});
