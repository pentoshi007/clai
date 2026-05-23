import { describe, expect, it, vi } from "vitest";
import { startThinkingSpinner } from "../src/ui/spinner.js";
import {
  rememberToolOutput,
  toggleLastToolOutput,
  updateLastToolSummary,
} from "../src/ui/tool-output.js";

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

describe("spinner preview API", () => {
  it("accepts pushPreview without throwing in non-TTY mode", () => {
    const spinner = startThinkingSpinner("test");
    expect(() => spinner.pushPreview("model thinking about ports…")).not.toThrow();
    spinner.stop();
  });
});

describe("tool output toggle", () => {
  it("toggles the last tool output without requiring a platform-specific key", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    rememberToolOutput({
      id: "test",
      label: "nmap 127.0.0.1",
      fullText: "PORT   STATE SERVICE\n80/tcp open  http",
    });
    updateLastToolSummary("80/tcp is open.");
    try {
      await expect(toggleLastToolOutput()).resolves.toBeUndefined();
      await expect(toggleLastToolOutput()).resolves.toBeUndefined();
      expect(write).toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
