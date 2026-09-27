import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replaceProviderKey = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../src/store/keys.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/store/keys.js")>(),
  replaceProviderKey,
}));

const auth = await import("../../src/llm/kiro-auth.js");
const device = await import("../../src/llm/kiro-social-device.js");
const { kiroProvider, resetKiroModelCacheForTesting } = await import("../../src/llm/kiro.js");
const fixtures = await import("../helpers/kiro-fixtures.js");

type FetchCall = { url: string; init: RequestInit | undefined };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return handler(url, init);
  }));
  return calls;
}

const envKeys = ["HOME", "CLAI_NO_BROWSER", "BROWSER", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "DISPLAY", "WAYLAND_DISPLAY"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  replaceProviderKey.mockClear();
  resetKiroModelCacheForTesting();
});

describe("Kiro token refresh routing", () => {
  it("refreshes social logins through the Kiro auth service even when client credentials are present", async () => {
    const calls = stubFetch(() => json({ accessToken: "new-access", expiresIn: 3600 }));
    const refreshed = await auth.refreshKiroToken("refresh", {
      authMethod: "github",
      clientId: "client",
      clientSecret: "secret",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${auth.KIRO_AUTH_SERVICE}/refreshToken`);
    expect(refreshed).toMatchObject({ accessToken: "new-access", authMethod: "github" });
  });

  it("falls back from OIDC to the social endpoint for imported tokens with rejected grants", async () => {
    const calls = stubFetch((url) =>
      url.includes("oidc.")
        ? json({ error: "invalid_grant" }, 400)
        : json({ accessToken: "social-access" })
    );
    const refreshed = await auth.refreshKiroToken("refresh", {
      authMethod: "imported",
      clientId: "client",
      clientSecret: "secret",
      region: "us-east-1",
    });
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual([
      "oidc.us-east-1.amazonaws.com",
      "prod.us-east-1.auth.desktop.kiro.dev",
    ]);
    expect(refreshed.accessToken).toBe("social-access");
  });

  it("reports expired Builder ID refresh tokens as requiring sign-in", async () => {
    stubFetch(() => json({ __type: "InvalidGrantException" }, 400));
    await expect(auth.refreshKiroToken("refresh", {
      authMethod: "builder-id",
      clientId: "client",
      clientSecret: "secret",
    })).rejects.toMatchObject({
      name: "KiroRefreshError",
      reauthRequired: true,
      message: expect.stringContaining("clai auth kiro"),
    });
  });

  it("refreshes external IdP credentials with a public-client form grant and rejects unknown hosts", async () => {
    const calls = stubFetch(() => json({ access_token: "idp-access", expires_in: 1200 }));
    const refreshed = await auth.refreshKiroToken("refresh", {
      authMethod: "external_idp",
      clientId: "public-client",
      tokenEndpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
      scope: "api://kiro/.default offline_access",
    });
    expect(calls[0]!.init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams(String(calls[0]!.init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      client_id: "public-client",
      refresh_token: "refresh",
      scope: "api://kiro/.default offline_access",
    });
    expect(refreshed).toMatchObject({ accessToken: "idp-access", authMethod: "external_idp" });
    await expect(auth.refreshKiroToken("refresh", {
      authMethod: "external_idp",
      clientId: "public-client",
      tokenEndpoint: "https://attacker.example/token",
    })).rejects.toThrow("not allowed");
  });

  it("shares one refresh between concurrent callers", async () => {
    let release: (() => void) | undefined;
    const calls = stubFetch(() => new Promise<Response>((resolve) => {
      release = () => resolve(json({ accessToken: "fresh" }));
    }));
    const key = auth.encodeKiroKey({ accessToken: "old", refreshToken: "shared", authMethod: "google" });
    const first = auth.maybeRefreshKiroCredential(key);
    const second = auth.maybeRefreshKiroCredential(key);
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(auth.decodeKiroKey(a!)?.accessToken).toBe("fresh");
  });

  it("refreshes near-expiry credentials before sending a generation request", async () => {
    const calls = stubFetch((url, init) => {
      if (url.endsWith("/refreshToken")) return json({ accessToken: "fresh", expiresIn: 3600 });
      if (fixtures.isKiroCatalogRequest(url, init)) return fixtures.kiroCatalogResponse([]);
      return fixtures.kiroStreamResponse([
        fixtures.encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "ok" }),
      ]);
    });
    const key = auth.encodeKiroKey({
      accessToken: "stale",
      refreshToken: "refresh",
      authMethod: "google",
      expiresAt: Date.now() + 60_000,
    });
    const result = await kiroProvider.complete(
      { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
      { apiKey: key },
    );
    expect(result.text).toBe("ok");
    expect(calls[0]!.url).toBe(`${auth.KIRO_AUTH_SERVICE}/refreshToken`);
    const generation = calls.find((call) => new Headers(call.init?.headers).get("Authorization") && !call.url.endsWith("/refreshToken") && !fixtures.isKiroCatalogRequest(call.url, call.init));
    expect(new Headers(generation?.init?.headers).get("Authorization")).toBe("Bearer fresh");
    expect(replaceProviderKey).toHaveBeenCalledOnce();
  });

  it("uses a five-minute refresh skew", () => {
    const now = 1_000_000;
    expect(auth.kiroCredentialNeedsRefresh({ accessToken: "a", expiresAt: now + 4 * 60_000 }, now)).toBe(true);
    expect(auth.kiroCredentialNeedsRefresh({ accessToken: "a", expiresAt: now + 10 * 60_000 }, now)).toBe(false);
    expect(auth.kiroCredentialNeedsRefresh({ accessToken: "a" }, now)).toBe(false);
  });

  it("derives the runtime region from the profile ARN before the OIDC region", () => {
    expect(auth.resolveKiroRuntimeRegion({
      region: "eu-north-1",
      profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC",
    })).toBe("eu-central-1");
    expect(auth.resolveKiroRuntimeRegion({ region: "eu-north-1" })).toBe("eu-central-1");
  });
});

describe("Kiro social device sign-in", () => {
  it("polls with slow_down backoff until approved", async () => {
    const polls: string[] = ["authorization_pending", "slow_down"];
    const calls = stubFetch((url) => {
      if (url.endsWith("/oauth/device/authorization")) {
        return json({
          deviceCode: "device",
          userCode: "ABCD-EFGH",
          verificationUri: "https://app.kiro.dev/account/device",
          verificationUriComplete: "https://app.kiro.dev/account/device?user_code=ABCD-EFGH&login_provider=Github",
          expiresInMilliseconds: 300_000,
          intervalInMilliseconds: 5_000,
        });
      }
      const status = polls.shift();
      return status
        ? json({ accessToken: null, refreshToken: null, status })
        : json({ accessToken: "access", refreshToken: "refresh", profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P", status: "success" });
    });
    const start = await device.startKiroSocialDeviceAuth("github");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ clientId: "kiro-cli", loginProvider: "Github" });
    const waits: number[] = [];
    const credential = await device.pollKiroSocialDeviceAuth(start, {
      wait: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([5_000, 10_000]);
    expect(credential).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      authMethod: "github",
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
    });
  });

  it("stops on a terminal device status", async () => {
    stubFetch(() => json({ accessToken: null, status: "invalid_token" }));
    await expect(device.pollKiroSocialDeviceAuth({
      provider: "google",
      deviceCode: "d",
      userCode: "u",
      verificationUri: "https://app.kiro.dev/account/device",
      verificationUriComplete: "https://app.kiro.dev/account/device",
      expiresInSeconds: 60,
      pollIntervalSeconds: 1,
    }, { wait: async () => {} })).rejects.toThrow("no longer valid");
  });

  it("treats explicit no-browser settings and SSH sessions as headless", () => {
    for (const key of envKeys.slice(1)) delete process.env[key];
    process.env.DISPLAY = ":0";
    expect(auth.isHeadlessEnvironment()).toBe(false);
    process.env.CLAI_NO_BROWSER = "1";
    expect(auth.isHeadlessEnvironment()).toBe(true);
    delete process.env.CLAI_NO_BROWSER;
    process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 50000";
    expect(auth.isHeadlessEnvironment()).toBe(true);
  });
});

describe("Kiro credential import", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "clai-kiro-import-"));
    process.env.HOME = home;
    await mkdir(join(home, ".aws", "sso", "cache"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reads the Kiro SSO token with its linked client registration and ISO expiry", async () => {
    const cache = join(home, ".aws", "sso", "cache");
    await writeFile(join(cache, "aaa-unrelated.json"), JSON.stringify({ accessToken: "other", startUrl: "https://other" }));
    await writeFile(join(cache, "hash123.json"), JSON.stringify({ clientId: "cid", clientSecret: "csecret" }));
    await writeFile(join(cache, "kiro-auth-token.json"), JSON.stringify({
      accessToken: "kiro-access",
      refreshToken: "kiro-refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      clientIdHash: "hash123",
      region: "eu-west-1",
      authMethod: "IdC",
      provider: "Enterprise",
    }));
    const stored = await auth.readKiroStoredAuth();
    expect(stored).toMatchObject({
      accessToken: "kiro-access",
      clientId: "cid",
      clientSecret: "csecret",
      region: "eu-west-1",
      authMethod: "builder-id",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    });
  });

  it("imports external IdP tokens with their token endpoint, scope, and IDE profile", async () => {
    const cache = join(home, ".aws", "sso", "cache");
    const profileDir = join(home, ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent");
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "profile.json"), JSON.stringify({ arn: "arn:aws:codewhisperer:us-east-1:1:profile/IDP" }));
    await writeFile(join(cache, "kiro-auth-token.json"), JSON.stringify({
      accessToken: "idp-access",
      refreshToken: "idp-refresh",
      provider: "ExternalIdp",
      clientId: "public-client",
      tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      scopes: ["api://kiro/.default", "offline_access"],
    }));
    const stored = await auth.readKiroStoredAuth();
    expect(stored).toMatchObject({
      authMethod: "external_idp",
      clientId: "public-client",
      tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      scope: "api://kiro/.default offline_access",
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/IDP",
    });
    expect(stored?.clientSecret).toBeUndefined();
    const roundTrip = auth.decodeKiroKey(auth.encodeKiroKey(stored!));
    expect(roundTrip).toMatchObject({ tokenEndpoint: stored!.tokenEndpoint, scope: stored!.scope });
  });
});
