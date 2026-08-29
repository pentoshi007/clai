import { describe, expect, it, vi } from "vitest";
import {
  authorizationServerMetadataCandidates,
  buildProtectedResourceMetadataUrl,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
} from "../../src/mcp/auth/metadata.js";
import { assertSafeDiscoveryUrl, canonicalResourceUri } from "../../src/mcp/auth/security.js";
import { McpTransportError } from "../../src/mcp/transport.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildProtectedResourceMetadataUrl", () => {
  it("inserts the well-known segment before the resource path", () => {
    expect(buildProtectedResourceMetadataUrl("https://h/mcp")).toBe(
      "https://h/.well-known/oauth-protected-resource/mcp",
    );
    expect(buildProtectedResourceMetadataUrl("https://mcp.notion.com/sse")).toBe(
      "https://mcp.notion.com/.well-known/oauth-protected-resource/sse",
    );
    expect(buildProtectedResourceMetadataUrl("https://api.githubcopilot.com/mcp/")).toBe(
      "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/",
    );
  });

  it("handles a root resource with no path", () => {
    expect(buildProtectedResourceMetadataUrl("https://h/")).toBe(
      "https://h/.well-known/oauth-protected-resource",
    );
  });
});

describe("assertSafeDiscoveryUrl", () => {
  it("allows public https URLs", () => {
    expect(() => assertSafeDiscoveryUrl("https://auth.example.com/x")).not.toThrow();
  });

  it("allows loopback http URLs", () => {
    expect(() => assertSafeDiscoveryUrl("http://127.0.0.1:8080/x")).not.toThrow();
  });

  it("rejects http on public hosts", () => {
    expect(() => assertSafeDiscoveryUrl("http://auth.example.com/x")).toThrow(McpTransportError);
  });

  it("rejects private and link-local hosts", () => {
    expect(() => assertSafeDiscoveryUrl("https://10.0.0.5/x")).toThrow(McpTransportError);
    expect(() => assertSafeDiscoveryUrl("https://169.254.169.254/x")).toThrow(McpTransportError);
    expect(() => assertSafeDiscoveryUrl("https://192.168.1.1/x")).toThrow(McpTransportError);
  });
});

describe("canonicalResourceUri", () => {
  it("preserves significant path and query identity while removing fragments", () => {
    expect(canonicalResourceUri("https://h/mcp/?a=b#c")).toBe("https://h/mcp/?a=b");
    expect(canonicalResourceUri("https://h/")).toBe("https://h");
  });
});

describe("authorizationServerMetadataCandidates", () => {
  it("orders RFC 8414 insertion, OIDC insertion, then OIDC append for a path issuer", () => {
    expect(authorizationServerMetadataCandidates("https://h/tenant")).toEqual([
      "https://h/.well-known/oauth-authorization-server/tenant",
      "https://h/.well-known/openid-configuration/tenant",
      "https://h/tenant/.well-known/openid-configuration",
    ]);
    expect(authorizationServerMetadataCandidates("https://github.com/login/oauth")).toEqual([
      "https://github.com/.well-known/oauth-authorization-server/login/oauth",
      "https://github.com/.well-known/openid-configuration/login/oauth",
      "https://github.com/login/oauth/.well-known/openid-configuration",
    ]);
  });

  it("dedupes candidates for a root issuer", () => {
    expect(authorizationServerMetadataCandidates("https://h")).toEqual([
      "https://h/.well-known/oauth-authorization-server",
      "https://h/.well-known/openid-configuration",
    ]);
  });
});

describe("discoverProtectedResourceMetadata", () => {
  it("returns authorization servers and scopes", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["read"],
        resource: "https://api.example.com/mcp",
      }),
    );
    const prm = await discoverProtectedResourceMetadata(
      "https://api.example.com/.well-known/oauth-protected-resource/mcp",
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(prm.authorizationServers).toEqual(["https://auth.example.com"]);
    expect(prm.scopesSupported).toEqual(["read"]);
  });

  it("throws when no authorization servers are listed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ scopes_supported: [] }));
    await expect(
      discoverProtectedResourceMetadata("https://api.example.com/.well-known/oauth-protected-resource", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(McpTransportError);
  });
});

describe("discoverAuthorizationServerMetadata", () => {
  it("falls through candidates until one returns valid metadata", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({}, 404);
      }
      if (url.endsWith("/.well-known/openid-configuration")) {
        return jsonResponse({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        });
      }
      return jsonResponse({}, 404);
    });
    const metadata = await discoverAuthorizationServerMetadata("https://auth.example.com", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(metadata.tokenEndpoint).toBe("https://auth.example.com/token");
    expect(seen[0]).toContain("/.well-known/oauth-authorization-server");
  });
});
