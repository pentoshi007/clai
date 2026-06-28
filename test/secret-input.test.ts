import { describe, expect, it } from "vitest";
import { sanitizeSecretInput } from "../src/tui/components/SecretInputPanel.js";

describe("secret input sanitization", () => {
  it("drops mouse wheel escape reports", () => {
    expect(sanitizeSecretInput("\x1b[<64;80;20M")).toBe("");
    expect(sanitizeSecretInput("\x1b[<65;80;20M")).toBe("");
  });

  it("keeps normal password text and drops control bytes", () => {
    expect(sanitizeSecretInput("abc123")).toBe("abc123");
    expect(sanitizeSecretInput("abc\x1b[A123")).toBe("abc123");
  });
});
