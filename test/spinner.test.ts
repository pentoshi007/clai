import { describe, expect, it } from "vitest";
import { startThinkingSpinner } from "../src/ui/spinner.js";

describe("thinking spinner", () => {
  it("is a no-op when stdout is not a TTY", () => {
    // Vitest stdout is not a TTY, so all methods should be safe to call.
    const spinner = startThinkingSpinner("test");
    expect(() => spinner.setLabel("x")).not.toThrow();
    expect(() => spinner.bumpReasoning(5)).not.toThrow();
    expect(() => spinner.stop()).not.toThrow();
    // Stopping twice must not blow up.
    expect(() => spinner.stop()).not.toThrow();
  });

  it("self-stops when its abort signal fires", () => {
    const ac = new AbortController();
    const spinner = startThinkingSpinner("test", ac.signal);
    ac.abort();
    // Public API stays callable post-abort.
    expect(() => spinner.bumpReasoning(1)).not.toThrow();
    expect(() => spinner.stop()).not.toThrow();
  });

  it("stops immediately when given an already-aborted signal", () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => startThinkingSpinner("test", ac.signal).stop()).not.toThrow();
  });
});
