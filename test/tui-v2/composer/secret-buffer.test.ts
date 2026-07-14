import { describe, expect, it } from "vitest";
import { SecretBuffer } from "../../../src/tui-v2/composer/secret-buffer.js";

describe("SecretBuffer", () => {
  it("inserts text and advances the cursor", () => {
    const buf = new SecretBuffer();
    const next = buf.insert("abc", 0);
    expect(next).toBe(3);
    expect(buf.reveal()).toBe("abc");
  });

  it("masks the value at the same length as the plaintext", () => {
    const buf = new SecretBuffer();
    buf.insert("sk-12345", 0);
    expect(buf.masked()).toBe("•".repeat(8));
  });

  it("never leaks the plaintext through toString or toJSON", () => {
    const buf = new SecretBuffer();
    buf.insert("super-secret-token", 0);
    expect(String(buf)).not.toContain("super-secret-token");
    expect(JSON.stringify({ token: buf })).not.toContain("super-secret-token");
    expect(String(buf)).toBe(buf.masked());
  });

  it("deleteBackward removes one character before the cursor", () => {
    const buf = new SecretBuffer();
    buf.insert("abcd", 0);
    const next = buf.deleteBackward(4);
    expect(next).toBe(3);
    expect(buf.reveal()).toBe("abc");
  });

  it("deleteBackward at offset 0 is a no-op", () => {
    const buf = new SecretBuffer();
    buf.insert("abc", 0);
    expect(buf.deleteBackward(0)).toBe(0);
    expect(buf.reveal()).toBe("abc");
  });

  it("clear() empties the buffer", () => {
    const buf = new SecretBuffer();
    buf.insert("abc", 0);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.reveal()).toBe("");
  });

  it("only reveal() returns the plaintext", () => {
    const buf = new SecretBuffer();
    buf.insert("hidden", 0);
    expect(buf.reveal()).toBe("hidden");
  });
});
