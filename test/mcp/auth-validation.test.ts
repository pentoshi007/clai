import { describe, expect, it } from "vitest";
import { validateServerEntry } from "../../src/mcp/validation.js";
import type { McpSubstitutionContext } from "../../src/mcp/substitution.js";
import type { McpHttpConfig } from "../../src/mcp/types.js";

function context(env: Record<string, string> = {}): McpSubstitutionContext {
  return { env, inputs: new Map(), workspaceFolder: "/tmp/ws" };
}

function httpConfig(server: unknown): McpHttpConfig {
  const validation = validateServerEntry("s", server, context());
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return validation.server.config as McpHttpConfig;
}

describe("auth block validation", () => {
  it("keeps behavior identical when no auth block is present", () => {
    const validation = validateServerEntry("s", { url: "https://h/mcp" }, context());
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.server.config.auth).toBeUndefined();
  });

  it("accepts kind none", () => {
    expect(httpConfig({ url: "https://h/mcp", auth: { kind: "none" } }).auth).toEqual({
      kind: "none",
    });
  });

  it("accepts bearer and marks the token secret", () => {
    const validation = validateServerEntry(
      "s",
      { url: "https://h/mcp", auth: { kind: "bearer", token: "tok-123" } },
      context(),
    );
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.server.config.auth).toEqual({ kind: "bearer", token: "tok-123" });
      expect(validation.server.secretValues).toContain("tok-123");
    }
  });

  it("accepts header auth and marks header values secret", () => {
    const validation = validateServerEntry(
      "s",
      { url: "https://h/mcp", auth: { kind: "header", headers: { "x-key": "SEKRET" } } },
      context(),
    );
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.server.config.auth).toEqual({
        kind: "header",
        headers: { "x-key": "SEKRET" },
      });
      expect(validation.server.secretValues).toContain("SEKRET");
    }
  });

  it("accepts oauth with all optional fields and marks the client secret", () => {
    const validation = validateServerEntry(
      "s",
      {
        url: "https://h/mcp",
        auth: {
          kind: "oauth",
          scopes: ["read", "write"],
          clientId: "cid",
          clientSecret: "csecret",
          resource: "https://h/mcp",
          authorizationServer: "https://as.example.com",
        },
      },
      context(),
    );
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      const auth = validation.server.config.auth;
      expect(auth?.kind).toBe("oauth");
      if (auth?.kind === "oauth") {
        expect(auth.scopes).toEqual(["read", "write"]);
        expect(auth.clientId).toBe("cid");
        expect(auth.authorizationServer).toBe("https://as.example.com");
      }
      expect(validation.server.secretValues).toContain("csecret");
    }
  });

  it("substitutes env values and marks them secret", () => {
    const validation = validateServerEntry(
      "s",
      { url: "https://h/mcp", auth: { kind: "bearer", token: "${env:MCP_TOKEN}" } },
      context({ MCP_TOKEN: "resolved-secret" }),
    );
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.server.config.auth).toEqual({ kind: "bearer", token: "resolved-secret" });
      expect(validation.server.secretValues).toContain("resolved-secret");
    }
  });

  it("rejects mixing fields from multiple kinds", () => {
    const validation = validateServerEntry(
      "s",
      { url: "https://h/mcp", auth: { kind: "bearer", token: "t", headers: { a: "b" } } },
      context(),
    );
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors.some((e) => e.includes('does not accept field "headers"'))).toBe(true);
    }
  });

  it("rejects an unknown auth kind", () => {
    const validation = validateServerEntry(
      "s",
      { url: "https://h/mcp", auth: { kind: "magic" } },
      context(),
    );
    expect(validation.ok).toBe(false);
  });

  it("rejects a bearer auth block with no token", () => {
    const validation = validateServerEntry(
      "s",
      { url: "https://h/mcp", auth: { kind: "bearer" } },
      context(),
    );
    expect(validation.ok).toBe(false);
  });
});
