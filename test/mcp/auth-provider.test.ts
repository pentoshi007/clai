import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthProvider } from "../../src/mcp/auth/provider.js";
import {
  defaultOAuthTokenStore,
  oauthTokenKey,
} from "../../src/mcp/auth/token-store.js";
import { McpTransportError } from "../../src/mcp/transport.js";
import {
  findGithubCredential,
  isGithubHost,
} from "../../src/mcp/auth/host-credentials.js";
import type {
  LoopbackAuthorizationResult,
  OAuthTokenSet,
  OAuthTokenStore,
} from "../../src/mcp/auth/types.js";
import type { LoopbackAuthorizationParams } from "../../src/mcp/auth/loopback.js";

const SERVER_URL = "https://api.example.com/mcp";
const ISSUER = "https://auth.example.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Capture {
  registered: boolean;
  tokenBodies: URLSearchParams[];
}

function makeRouter(capture: Capture, includePrmResource = false): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
      return jsonResponse({
        authorization_servers: [ISSUER],
        scopes_supported: ["read"],
        ...(includePrmResource ? { resource: SERVER_URL } : {}),
      });
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
      });
    }
    if (url === `${ISSUER}/register`) {
      capture.registered = true;
      return jsonResponse({ client_id: "dcr-client" });
    }
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body));
      capture.tokenBodies.push(body);
      if (body.get("grant_type") === "refresh_token") {
        return jsonResponse({ access_token: "AT-REFRESHED", token_type: "bearer", expires_in: 3600 });
      }
      return jsonResponse({
        access_token: "AT1",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "RT1",
      });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
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

const loopback = async (
  params: LoopbackAuthorizationParams,
): Promise<LoopbackAuthorizationResult> => {
  await params.buildAuthorizationUrl("http://127.0.0.1:1/callback", "STATE");
  return { code: "CODE", state: "STATE", redirectUri: "http://127.0.0.1:1/callback" };
};

describe("OAuth provider recovery of persisted tokens", () => {
  it("attaches a stored token on the first request of a cold process", async () => {
    const store = memoryStore();
    store.map.set(oauthTokenKey(SERVER_URL, ISSUER), {
      accessToken: "AT-DISK",
      tokenType: "bearer",
      expiresAt: Date.now() + 3_600_000,
    });
    const resourceLookups: string[] = [];
    const warmStore: OAuthTokenStore = {
      ...store,
      async loadForResource(resource) {
        resourceLookups.push(resource);
        for (const [key, tokens] of store.map) {
          if (key.startsWith(`${resource}|`)) return tokens;
        }
        return undefined;
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    const provider = createAuthProvider(
      { kind: "oauth" },
      { serverUrl: SERVER_URL, tokenStore: warmStore, fetchImpl },
    );

    expect(await provider.headers()).toEqual({ authorization: "Bearer AT-DISK" });
    expect(resourceLookups).toEqual([SERVER_URL]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await provider.headers()).toEqual({ authorization: "Bearer AT-DISK" });
    expect(resourceLookups).toHaveLength(1);
  });

  it("does not warm twice when no token is on disk", async () => {
    const lookups: string[] = [];
    const store: OAuthTokenStore = {
      async load() {
        return undefined;
      },
      async save() {},
      async remove() {},
      async loadForResource(resource) {
        lookups.push(resource);
        return undefined;
      },
    };
    const provider = createAuthProvider(
      { kind: "oauth" },
      { serverUrl: SERVER_URL, tokenStore: store },
    );

    expect(await provider.headers()).toEqual({});
    expect(await provider.headers()).toEqual({});
    expect(lookups).toHaveLength(1);
  });

  it("runs one authorization for concurrent unauthorized responses", async () => {
    const capture: Capture = { registered: false, tokenBodies: [] };
    const opens: string[] = [];
    let flows = 0;
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        tokenStore: memoryStore(),
        fetchImpl: makeRouter(capture),
        openBrowser: async (url) => {
          opens.push(url);
        },
        runLoopback: async (params) => {
          flows += 1;
          await params.buildAuthorizationUrl("http://127.0.0.1:1/callback", "STATE");
          await params.openBrowser("http://127.0.0.1:1/authorize");
          return {
            code: "CODE",
            state: "STATE",
            redirectUri: "http://127.0.0.1:1/callback",
          };
        },
      },
    );

    const [first, second] = await Promise.all([
      provider.onUnauthorized(undefined),
      provider.onUnauthorized(undefined),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(flows).toBe(1);
    expect(opens).toHaveLength(1);
    expect(capture.tokenBodies).toHaveLength(1);
  });

  it("explains both supported credentials when a server has no dynamic registration", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
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
    }) as unknown as typeof fetch;
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        tokenStore: memoryStore(),
        fetchImpl,
        openBrowser: async () => {},
        runLoopback: loopback,
      },
    );

    const error = await provider.onUnauthorized(undefined).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(McpTransportError);
    const message = (error as McpTransportError).message;
    expect(message).toContain("dynamic client registration");
    expect(message).toContain('"kind": "bearer"');
    expect(message).toContain("clientId");
    expect(message).toContain(".clai/mcp.json");
  });
});

describe("GitHub host credential fallback", () => {
  const GITHUB_URL = "https://api.githubcopilot.com/mcp/";

  it("recognises GitHub-owned hosts only", () => {
    expect(isGithubHost(GITHUB_URL)).toBe(true);
    expect(isGithubHost("https://api.github.com/mcp")).toBe(true);
    expect(isGithubHost("https://mcp.github.com/x")).toBe(true);
    expect(isGithubHost("https://github.com.evil.example/mcp")).toBe(false);
    expect(isGithubHost("https://notgithub.com/mcp")).toBe(false);
    expect(isGithubHost("not a url")).toBe(false);
  });

  it("prefers an explicit environment token over the gh CLI", async () => {
    const credential = await findGithubCredential(GITHUB_URL, {
      env: { GITHUB_TOKEN: "env-token" },
      readCliToken: async () => "cli-token",
    });
    expect(credential).toEqual({ token: "env-token", source: "$GITHUB_TOKEN" });
  });

  it("falls back to the gh CLI when no environment token is set", async () => {
    const credential = await findGithubCredential(GITHUB_URL, {
      env: {},
      readCliToken: async () => "cli-token",
    });
    expect(credential).toEqual({ token: "cli-token", source: "gh auth token" });
  });

  it("never looks for a credential on a non-GitHub host", async () => {
    let consulted = false;
    const credential = await findGithubCredential(SERVER_URL, {
      env: { GITHUB_TOKEN: "env-token" },
      readCliToken: async () => {
        consulted = true;
        return "cli-token";
      },
    });
    expect(credential).toBeUndefined();
    expect(consulted).toBe(false);
  });

  it("authenticates a GitHub MCP server from the local credential without a browser", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: GITHUB_URL,
        tokenStore: memoryStore(),
        fetchImpl,
        env: { GITHUB_TOKEN: "ghp-local" },
      },
    );

    expect(await provider.headers()).toEqual({ authorization: "Bearer ghp-local" });
    expect(provider.liveSecrets()).toContain("ghp-local");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves a non-GitHub server unauthenticated when no token is stored", async () => {
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        tokenStore: memoryStore(),
        env: { GITHUB_TOKEN: "ghp-local" },
      },
    );

    expect(await provider.headers()).toEqual({});
  });

  it("adopts the local credential instead of failing when the issuer cannot register clients", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/oauth-protected-resource")) {
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
    }) as unknown as typeof fetch;
    let browserOpened = false;
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: GITHUB_URL,
        tokenStore: memoryStore(),
        fetchImpl,
        env: {},
        readHostToken: async () => "gh-cli-token",
        openBrowser: async () => {
          browserOpened = true;
        },
        runLoopback: loopback,
      },
    );

    expect(await provider.onUnauthorized(undefined)).toBe(true);
    expect(browserOpened).toBe(false);
    expect(await provider.headers()).toEqual({ authorization: "Bearer gh-cli-token" });
  });
});

describe("createAuthProvider non-oauth kinds", () => {
  it("none produces no headers and no secrets", async () => {
    const provider = createAuthProvider({ kind: "none" }, { serverUrl: SERVER_URL });
    expect(await provider.headers()).toEqual({});
    expect(await provider.onUnauthorized(undefined)).toBe(false);
    expect(provider.liveSecrets()).toEqual([]);
  });

  it("bearer sends an Authorization header and exposes the token", async () => {
    const provider = createAuthProvider({ kind: "bearer", token: "T0P" }, { serverUrl: SERVER_URL });
    expect(await provider.headers()).toEqual({ authorization: "Bearer T0P" });
    expect(provider.liveSecrets()).toContain("T0P");
  });

  it("header passes configured headers through and exposes their values", async () => {
    const provider = createAuthProvider(
      { kind: "header", headers: { "x-api-key": "SECRET" } },
      { serverUrl: SERVER_URL },
    );
    expect(await provider.headers()).toEqual({ "x-api-key": "SECRET" });
    expect(provider.liveSecrets()).toContain("SECRET");
  });
});

describe("OAuth provider flow", () => {
  it("runs discovery, DCR, PKCE exchange, and caches the token", async () => {
    const capture: Capture = { registered: false, tokenBodies: [] };
    const store = memoryStore();
    let clock = 1_000_000;
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        fetchImpl: makeRouter(capture),
        now: () => clock,
        tokenStore: store,
        runLoopback: loopback,
        openBrowser: async () => undefined,
        interactive: true,
      },
    );
    expect(await provider.onUnauthorized(undefined)).toBe(true);
    expect(capture.registered).toBe(true);
    const authBody = capture.tokenBodies[0]!;
    expect(authBody.get("grant_type")).toBe("authorization_code");
    expect(authBody.get("code_verifier")).toBeTruthy();
    expect(authBody.get("resource")).toBe(SERVER_URL);
    expect(await provider.headers()).toEqual({ authorization: "Bearer AT1" });
    expect(provider.liveSecrets()).toEqual(expect.arrayContaining(["AT1", "RT1"]));
    expect(store.map.get(oauthTokenKey(SERVER_URL, ISSUER))?.accessToken).toBe("AT1");

    clock = 5_000_000;
    expect(await provider.headers()).toEqual({ authorization: "Bearer AT-REFRESHED" });
    const refreshBody = capture.tokenBodies.at(-1)!;
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("resource")).toBe(SERVER_URL);
  });

  it("uses challenge metadata and its exact resource for authorization and exchange", async () => {
    const metadataUrl =
      "https://api.example.com/.well-known/oauth-protected-resource/mcp/";
    const resource = "https://api.example.com/mcp/";
    const capture: Capture = { registered: false, tokenBodies: [] };
    const store = memoryStore();
    let authorizationUrl = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === metadataUrl) {
        return jsonResponse({
          resource,
          authorization_servers: [ISSUER],
          scopes_supported: ["default"],
        });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
        });
      }
      if (url === `${ISSUER}/token`) {
        const body = new URLSearchParams(String(init?.body));
        capture.tokenBodies.push(body);
        return jsonResponse({ access_token: "AT-CHALLENGE", token_type: "bearer" });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;
    const provider = createAuthProvider(
      { kind: "oauth", clientId: "configured-client" },
      {
        serverUrl: SERVER_URL,
        fetchImpl,
        tokenStore: store,
        runLoopback: async (params) => {
          authorizationUrl = await params.buildAuthorizationUrl(
            "http://127.0.0.1:1/callback",
            "STATE",
          );
          return {
            code: "CODE",
            state: "STATE",
            redirectUri: "http://127.0.0.1:1/callback",
          };
        },
        openBrowser: async () => undefined,
        interactive: true,
      },
    );

    expect(
      await provider.onUnauthorized({ scheme: "Bearer", resourceMetadataUrl: metadataUrl }),
    ).toBe(true);
    const authorize = new URL(authorizationUrl);
    expect(authorize.searchParams.get("resource")).toBe(resource);
    expect(authorize.searchParams.get("scope")).toBe("default");
    expect(capture.tokenBodies[0]?.get("resource")).toBe(resource);
    expect(await provider.headers()).toEqual({ authorization: "Bearer AT-CHALLENGE" });
    expect(store.map.get(oauthTokenKey(resource, ISSUER))?.accessToken).toBe(
      "AT-CHALLENGE",
    );
  });

  it("reuses a valid stored lowercase bearer token without a browser", async () => {
    const capture: Capture = { registered: false, tokenBodies: [] };
    const store = memoryStore();
    store.map.set(oauthTokenKey(SERVER_URL, ISSUER), {
      accessToken: "STORED",
      tokenType: "bearer",
      expiresAt: 5_000_000,
      clientId: "pre-client",
    });
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        fetchImpl: makeRouter(capture),
        now: () => 1_000_000,
        tokenStore: store,
        interactive: false,
      },
    );

    expect(await provider.onUnauthorized(undefined)).toBe(true);
    expect(capture.tokenBodies).toHaveLength(0);
    expect(await provider.headers()).toEqual({ authorization: "Bearer STORED" });
  });

  it("reuses a stored refresh token without a browser", async () => {
    const capture: Capture = { registered: false, tokenBodies: [] };
    const store = memoryStore();
    store.map.set(oauthTokenKey(SERVER_URL, ISSUER), {
      accessToken: "OLD",
      tokenType: "bearer",
      refreshToken: "RT",
      expiresAt: 1000,
      clientId: "pre-client",
      scope: "read",
    });
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        fetchImpl: makeRouter(capture),
        now: () => 5_000_000,
        tokenStore: store,
        interactive: false,
      },
    );
    expect(await provider.onUnauthorized(undefined)).toBe(true);
    expect(capture.registered).toBe(false);
    expect(await provider.headers()).toEqual({ authorization: "Bearer AT-REFRESHED" });
  });

  it("fails fast with an actionable error when no browser is available", async () => {
    const capture: Capture = { registered: false, tokenBodies: [] };
    const provider = createAuthProvider(
      { kind: "oauth" },
      {
        serverUrl: SERVER_URL,
        fetchImpl: makeRouter(capture),
        tokenStore: memoryStore(),
        interactive: false,
      },
    );
    await expect(provider.onUnauthorized(undefined)).rejects.toThrow(/login/i);
  });
});

describe("defaultOAuthTokenStore fallback file", () => {
  let dataDir: string;
  const prevDataDir = process.env.CLAI_DATA_DIR;
  const prevDisable = process.env.CLAI_DISABLE_KEYCHAIN;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "clai-oauth-store-"));
    process.env.CLAI_DATA_DIR = dataDir;
    process.env.CLAI_DISABLE_KEYCHAIN = "1";
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (prevDataDir === undefined) delete process.env.CLAI_DATA_DIR;
    else process.env.CLAI_DATA_DIR = prevDataDir;
    if (prevDisable === undefined) delete process.env.CLAI_DISABLE_KEYCHAIN;
    else process.env.CLAI_DISABLE_KEYCHAIN = prevDisable;
  });

  it("round-trips tokens keyed by resource and issuer", async () => {
    const key = oauthTokenKey(SERVER_URL, ISSUER);
    const tokens: OAuthTokenSet = {
      accessToken: "stored-access",
      tokenType: "Bearer",
      refreshToken: "stored-refresh",
      expiresAt: 123,
    };
    await defaultOAuthTokenStore.save(key, tokens);
    expect(await defaultOAuthTokenStore.load(key)).toEqual(tokens);
    await defaultOAuthTokenStore.remove(key);
    expect(await defaultOAuthTokenStore.load(key)).toBeUndefined();
  });
});
