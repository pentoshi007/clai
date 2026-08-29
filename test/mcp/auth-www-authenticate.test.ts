import { describe, expect, it } from "vitest";
import { parseWwwAuthenticate } from "../../src/mcp/auth/www-authenticate.js";

describe("parseWwwAuthenticate", () => {
  it("parses the RFC 9728 Bearer challenge shape", () => {
    const challenge = parseWwwAuthenticate(
      'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="read write", error="invalid_token"',
    );
    expect(challenge?.scheme).toBe("Bearer");
    expect(challenge?.resourceMetadataUrl).toBe(
      "https://api.example.com/.well-known/oauth-protected-resource",
    );
    expect(challenge?.scope).toBe("read write");
    expect(challenge?.error).toBe("invalid_token");
  });

  it("parses a bare scheme with no parameters", () => {
    const challenge = parseWwwAuthenticate("Bearer");
    expect(challenge?.scheme).toBe("Bearer");
    expect(challenge?.resourceMetadataUrl).toBeUndefined();
  });

  it("accepts unquoted parameter values", () => {
    const challenge = parseWwwAuthenticate("Bearer error=invalid_request");
    expect(challenge?.error).toBe("invalid_request");
  });

  it("returns undefined for empty or missing headers", () => {
    expect(parseWwwAuthenticate(undefined)).toBeUndefined();
    expect(parseWwwAuthenticate("")).toBeUndefined();
    expect(parseWwwAuthenticate("   ")).toBeUndefined();
  });
});
