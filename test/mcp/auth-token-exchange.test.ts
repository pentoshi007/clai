import { describe, expect, it, vi } from "vitest";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "../../src/mcp/auth/token-exchange.js";

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "AT",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "RT",
      scope: "read",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("exchangeAuthorizationCode", () => {
  it("sends the authorization code, code_verifier, and resource", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return tokenResponse();
    });
    const result = await exchangeAuthorizationCode(
      {
        tokenEndpoint: "https://auth.example.com/token",
        code: "CODE",
        redirectUri: "http://127.0.0.1:5000/callback",
        clientId: "client-123",
        codeVerifier: "verifier-xyz",
        resource: "https://api.example.com/mcp",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("CODE");
    expect(params.get("code_verifier")).toBe("verifier-xyz");
    expect(params.get("resource")).toBe("https://api.example.com/mcp");
    expect(params.get("client_id")).toBe("client-123");
    expect(result.accessToken).toBe("AT");
    expect(result.refreshToken).toBe("RT");
  });

  it("uses HTTP Basic auth when a client secret is present", async () => {
    let authHeader: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>).authorization;
      return tokenResponse();
    });
    await exchangeAuthorizationCode(
      {
        tokenEndpoint: "https://auth.example.com/token",
        code: "CODE",
        redirectUri: "http://127.0.0.1:5000/callback",
        clientId: "id",
        clientSecret: "secret",
        codeVerifier: "v",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(authHeader).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
  });
});

describe("refreshAccessToken", () => {
  it("sends grant_type refresh_token with the resource indicator", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return tokenResponse();
    });
    await refreshAccessToken(
      {
        tokenEndpoint: "https://auth.example.com/token",
        refreshToken: "RT",
        clientId: "client-123",
        resource: "https://api.example.com/mcp",
        scope: "read",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("RT");
    expect(params.get("resource")).toBe("https://api.example.com/mcp");
    expect(params.get("scope")).toBe("read");
  });
});
