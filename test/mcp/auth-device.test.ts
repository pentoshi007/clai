import { describe, expect, it, vi } from "vitest";
import { createAuthProvider } from "../../src/mcp/auth/provider.js";
import { McpTransportError } from "../../src/mcp/transport.js";
import type {
  DeviceAuthorizationInfo,
  OAuthTokenSet,
  OAuthTokenStore,
} from "../../src/mcp/auth/types.js";

const SERVER_URL = "https://api.example.com/mcp";
const ISSUER = "https://auth.example.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStore(): OAuthTokenStore & { map: Map<string, OAuthTokenSet> } {
  const map = new Map<string, OAuthTokenSet>();
  return {
    map,
    async load(key) {
      return map.get(key);
    },
    async save(key, tokens) {
      map.set(key, tokens);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

function deviceRouter(capture: {
  registrationBodies: Array<Record<string, unknown>>;
  devicePolls: number;
  pendingPolls?: number;
}): typeof fetch {
  const pendingBeforeSuccess = capture.pendingPolls ?? 1;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
      return jsonResponse({ authorization_servers: [ISSUER] });
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        device_authorization_endpoint: `${ISSUER}/device`,
      });
    }
    if (url === `${ISSUER}/register`) {
      capture.registrationBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return jsonResponse({ client_id: "device-client" });
    }
    if (url === `${ISSUER}/device`) {
      return jsonResponse({
        device_code: "dc-1",
        user_code: "WXYZ-1234",
        verification_uri: "https://auth.example.com/activate",
        interval: 1,
        expires_in: 600,
      });
    }
    if (url === `${ISSUER}/token`) {
      capture.devicePolls += 1;
      if (capture.devicePolls <= pendingBeforeSuccess) {
        return jsonResponse({ error: "authorization_pending" }, 400);
      }
      return jsonResponse({
        access_token: "AT-DEVICE",
        token_type: "bearer",
        expires_in: 3600,
      });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
}

describe("OAuth device flow", () => {
  it("uses the device flow when non-interactive and the server advertises it", async () => {
    const capture = { registrationBodies: [] as Array<Record<string, unknown>>, devicePolls: 0 };
    const shown: DeviceAuthorizationInfo[] = [];
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        interactive: false,
        tokenStore: memoryStore(),
        fetchImpl: deviceRouter(capture),
        onDeviceAuthorization: (info) => {
          shown.push(info);
        },
      },
    );
    const ok = await provider.onUnauthorized(undefined);
    expect(ok).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.userCode).toBe("WXYZ-1234");
    expect(shown[0]?.verificationUri).toBe("https://auth.example.com/activate");
    expect(capture.registrationBodies[0]?.grant_types).toContain(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    const headers = await provider.headers();
    expect(headers.authorization).toBe("Bearer AT-DEVICE");
  });

  it("prefers the device flow even when a browser is available", async () => {
    const capture = { registrationBodies: [] as Array<Record<string, unknown>>, devicePolls: 0, pendingPolls: 0 };
    const shown: DeviceAuthorizationInfo[] = [];
    const browser = vi.fn(async () => {});
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        interactive: true,
        tokenStore: memoryStore(),
        fetchImpl: deviceRouter(capture),
        openBrowser: browser,
        onDeviceAuthorization: (info) => {
          shown.push(info);
        },
      },
    );
    const ok = await provider.onUnauthorized(undefined);
    expect(ok).toBe(true);
    expect(browser).not.toHaveBeenCalled();
    expect(shown).toHaveLength(1);
    const headers = await provider.headers();
    expect(headers.authorization).toBe("Bearer AT-DEVICE");
  });

  it("reports clearly when neither browser nor device flow is possible", async () => {
    const router = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return jsonResponse({ authorization_servers: [ISSUER] });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
        });
      }
      return jsonResponse({}, 404);
    });
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        interactive: false,
        tokenStore: memoryStore(),
        fetchImpl: router as unknown as typeof fetch,
      },
    );
    await expect(provider.onUnauthorized(undefined)).rejects.toThrow(
      /no browser is available/,
    );
  });
});
