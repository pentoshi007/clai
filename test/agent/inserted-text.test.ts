import { describe, expect, it } from "vitest";

import { insertedText } from "../../src/agent/turn/inserted-text.js";

describe("insertedText", () => {
  it("removes one exact leading prefix", () => {
    expect(insertedText("memory\n\nsummary", "memory\n\n")).toBe("summary");
  });

  it("retains values whose prefix does not match exactly", () => {
    expect(insertedText("Memory\n\nsummary", "memory\n\n")).toBe("Memory\n\nsummary");
    expect(insertedText("xmemory\n\nsummary", "memory\n\n")).toBe("xmemory\n\nsummary");
  });

  it("removes only one repeated prefix", () => {
    expect(insertedText("prefixprefixvalue", "prefix")).toBe("prefixvalue");
  });

  it("leaves a value unchanged for an empty prefix", () => {
    expect(insertedText("value", "")).toBe("value");
  });
});
