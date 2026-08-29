import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPkcePair, randomState } from "../../src/mcp/auth/pkce.js";

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("createPkcePair", () => {
  it("produces an S256 challenge that is the base64url sha256 of the verifier", () => {
    const pair = createPkcePair();
    expect(pair.method).toBe("S256");
    const expected = base64Url(createHash("sha256").update(pair.verifier).digest());
    expect(pair.challenge).toBe(expected);
  });

  it("uses an unreserved verifier within the 43-128 length range", () => {
    for (let i = 0; i < 20; i += 1) {
      const { verifier } = createPkcePair();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(/^[A-Za-z0-9\-._~]+$/.test(verifier)).toBe(true);
    }
  });

  it("generates unique verifiers", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("randomState", () => {
  it("returns unique unreserved strings", () => {
    const a = randomState();
    const b = randomState();
    expect(a).not.toBe(b);
    expect(/^[A-Za-z0-9\-._~]+$/.test(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
