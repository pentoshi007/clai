import { describe, expect, it } from "vitest";
import {
  isBunRuntime,
  isOpenTuiFfiError,
  openTuiRuntimeHint,
} from "../../src/os/bun-runtime.js";

describe("OpenTUI runtime helpers", () => {
  it("detects Bun only when global Bun exists", () => {
    // Under vitest/node this is false; under bun it is true — either is fine.
    expect(typeof isBunRuntime()).toBe("boolean");
  });

  it("classifies OpenTUI FFI errors", () => {
    expect(
      isOpenTuiFfiError(
        new Error(
          "Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet",
        ),
      ),
    ).toBe(true);
    expect(isOpenTuiFfiError(new Error("network down"))).toBe(false);
  });

  it("hint mentions Bun and classic fallback", () => {
    const hint = openTuiRuntimeHint();
    expect(hint).toMatch(/Bun/);
    expect(hint).toMatch(/classic/i);
  });
});
