import { describe, expect, it } from "vitest";
import {
  MODE_CYCLE_ORDER,
  modeSwitchSummary,
  nextMode,
} from "../../src/ui-core/actions/mode-cycle.js";

describe("mode cycle", () => {
  it("walks ask → agent → plan → ask", () => {
    expect(MODE_CYCLE_ORDER).toEqual(["ask", "agent", "plan"]);
    expect(nextMode("ask")).toBe("agent");
    expect(nextMode("agent")).toBe("plan");
    expect(nextMode("plan")).toBe("ask");
  });

  it("falls back to the first mode for an unknown current", () => {
    expect(nextMode("weird" as never)).toBe("ask");
  });

  it("gives a distinct one-line summary per mode", () => {
    const summaries = new Set([
      modeSwitchSummary("ask"),
      modeSwitchSummary("agent"),
      modeSwitchSummary("plan"),
    ]);
    expect(summaries.size).toBe(3);
    for (const summary of summaries) expect(summary.length).toBeGreaterThan(0);
  });
});
