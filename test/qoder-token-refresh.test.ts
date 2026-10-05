import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QoderCredential } from "../src/llm/qoder/qoder.js";

const h = vi.hoisted(() => ({
  keys: [] as Array<{ id: string; value: string; createdAt: number; refreshToken?: string; expiresAt?: number }>,
  replaceProviderKey: vi.fn(),
}));

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => provider === "qoder"
      ? { keys: h.keys, activeIndex: 0, source: "fallback" as const }
      : { keys: [], activeIndex: 0, source: "missing" as const },
    replaceProviderKey: h.replaceProviderKey,
  };
});

function storedCredential(overrides: Partial<QoderCredential> = {}): QoderCredential {
  return {
    uid: "qoder-user",
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expireTime: Math.floor((Date.now() + 60_000) / 1000),
    refreshTokenExpireTime: Math.floor((Date.now() + 86_400_000) / 1000),
    encryptUserInfo: "encrypted-user",
    key: "user-key",
    machineId: "machine-id-uuid",
    machineCode: "machine-code",
    machineToken: "machine-token",
    machineType: "machine-type",
    ...overrides,
  };
}

function refreshResponse(): Response {
  return new Response(JSON.stringify({
    device_token: "fresh-access-token",
    refresh_token: "rotated-refresh-token",
    expires_at: Math.floor((Date.now() + 3_600_000) / 1000),
    refresh_token_expires_at: Math.floor((Date.now() + 172_800_000) / 1000),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function sse(body: string, statusCodeValue = 200): Response {
  const frame = JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body,
    statusCodeValue,
    statusCode: statusCodeValue === 200 ? "OK" : "UNAUTHORIZED",
  });
  return new Response(`data:${frame}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function storedKey(credential: QoderCredential): string {
  return JSON.stringify(credential);
}

beforeEach(() => {
  vi.resetModules();
  h.keys.length = 0;
  h.replaceProviderKey.mockReset().mockImplementation(async (
    provider: string,
    oldValue: string,
    newValue: string,
    metadata?: { refreshToken?: string; expiresAt?: number },
  ) => {
    if (provider !== "qoder") return false;
    const slot = h.keys.find((key) => key.value === oldValue);
    if (!slot) return false;
    slot.value = newValue;
    Object.assign(slot, metadata);
    return true;
  });
  vi.unstubAllGlobals();
});

describe("Qoder device-token refresh", () => {
  it("refreshes near-expiry tokens and persists rotated access and refresh tokens", async () => {
    const oldCredential = storedCredential();
    const oldValue = storedKey(oldCredential);
    h.keys.push({ id: "qoder-slot", value: oldValue, createdAt: 1 });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/v1/deviceToken/refresh")) return refreshResponse();
      return new Response(JSON.stringify({ chat: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    const auth = { apiKey: oldValue };

    await qoderProvider.ping!(auth);

    const refresh = calls[0]!;
    expect(refresh.url).toBe("https://openapi.qoder.sh/api/v1/deviceToken/refresh");
    expect(refresh.init?.method).toBe("POST");
    expect(JSON.parse(String(refresh.init?.body))).toEqual({
      refresh_token: "old-refresh-token",
      machine_id: "machine-id-uuid",
      machine_type: "machine-type",
      machine_code: "machine-code",
    });
    expect(auth.apiKey).not.toBe(oldValue);
    expect(JSON.parse(auth.apiKey!)).toMatchObject({
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token",
      expireTime: expect.any(Number),
      refreshTokenExpireTime: expect.any(Number),
    });
    expect(h.keys[0]!.value).toBe(auth.apiKey);
    expect(h.keys[0]!.refreshToken).toBe("rotated-refresh-token");
    expect(h.replaceProviderKey).toHaveBeenCalledOnce();
  });

  it("does not refresh a token outside the five-minute window", async () => {
    const credential = storedCredential({
      expireTime: Math.floor((Date.now() + 60 * 60_000) / 1000),
    });
    const value = storedKey(credential);
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ chat: [] }), { status: 200 });
    }));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");

    await qoderProvider.ping!({ apiKey: value });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("deviceToken/refresh");
    expect(h.replaceProviderKey).not.toHaveBeenCalled();
  });

  it("refreshes once and retries an inference rejected with 401", async () => {
    const credential = storedCredential({
      expireTime: Math.floor((Date.now() + 3_600_000) / 1000),
    });
    const oldValue = storedKey(credential);
    h.keys.push({ id: "qoder-slot", value: oldValue, createdAt: 1 });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v1/deviceToken/refresh")) return refreshResponse();
      if (calls.filter((call) => call.includes("agent_chat_generation")).length === 1) {
        return sse(JSON.stringify({ message: "access token expired" }), 401);
      }
      return sse(JSON.stringify({
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      }));
    }));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    const auth = { apiKey: oldValue };

    const result = await qoderProvider.stream!(
      { model: "qfmodel:free", messages: [{ role: "user", content: "test" }] },
      auth,
      () => {},
    );

    expect(result.text).toBe("ok");
    expect(calls.filter((call) => call.includes("agent_chat_generation"))).toHaveLength(2);
    expect(calls.filter((call) => call.endsWith("/api/v1/deviceToken/refresh"))).toHaveLength(1);
    expect(h.keys[0]!.value).toBe(auth.apiKey);
  });

  it("coalesces concurrent refreshes and updates both callers", async () => {
    const value = storedKey(storedCredential());
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    const fetcher = vi.fn(async (input: unknown) => {
      await Promise.resolve();
      return String(input).endsWith("/api/v1/deviceToken/refresh")
        ? refreshResponse()
        : new Response(JSON.stringify({ chat: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    const first = { apiKey: value };
    const second = { apiKey: value };

    await Promise.all([qoderProvider.ping!(first), qoderProvider.ping!(second)]);

    expect(first.apiKey).not.toBe(value);
    expect(second.apiKey).toBe(first.apiKey);
    expect(h.keys[0]!.value).toBe(first.apiKey);
    expect(h.replaceProviderKey).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/deviceToken/refresh"))).toHaveLength(1);
  });

  it("does not infer if saving rotated credentials fails", async () => {
    const value = storedKey(storedCredential());
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    h.replaceProviderKey.mockRejectedValueOnce(new Error("disk unavailable"));
    const fetcher = vi.fn(async () => refreshResponse());
    vi.stubGlobal("fetch", fetcher);
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    const auth = { apiKey: value };

    await expect(qoderProvider.ping!(auth)).rejects.toThrow("could not save the rotated tokens");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(auth.apiKey).toBe(value);
    expect(h.keys[0]!.value).toBe(value);
  });

  it("fails without network calls when an expired token has no refresh token", async () => {
    const value = storedKey(storedCredential({
      refreshToken: undefined,
      expireTime: Math.floor((Date.now() - 60_000) / 1000),
    }));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");

    await expect(qoderProvider.ping!({ apiKey: value })).rejects.toThrow("no refresh token is available");

    expect(fetcher).not.toHaveBeenCalled();
    expect(h.replaceProviderKey).not.toHaveBeenCalled();
  });

  it("does not use the access token after a rejected refresh", async () => {
    const value = storedKey(storedCredential());
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: "invalid refresh token" }), { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");

    await expect(qoderProvider.ping!({ apiKey: value })).rejects.toThrow("invalid refresh token");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(h.replaceProviderKey).not.toHaveBeenCalled();
  });

  it("uses a still-valid access token after a transient refresh failure", async () => {
    const value = storedKey(storedCredential({ expireTime: Math.floor((Date.now() + 120_000) / 1000) }));
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    const fetcher = vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/api/v1/deviceToken/refresh")) throw new Error("temporary network failure");
      return new Response(JSON.stringify({ chat: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    const auth = { apiKey: value };

    await qoderProvider.ping!(auth);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(auth.apiKey).toBe(value);
    expect(h.replaceProviderKey).not.toHaveBeenCalled();
  });

  it("stops after the single auth retry is rejected", async () => {
    const value = storedKey(storedCredential({ expireTime: Math.floor((Date.now() + 3_600_000) / 1000) }));
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith("/api/v1/deviceToken/refresh")
        ? refreshResponse()
        : sse(JSON.stringify({ message: "access token expired" }), 401);
    }));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");

    await expect(qoderProvider.stream!(
      { model: "qfmodel:free", messages: [{ role: "user", content: "test" }] },
      { apiKey: value },
      () => {},
    )).rejects.toMatchObject({ status: 401 });

    expect(calls.filter((url) => url.includes("agent_chat_generation"))).toHaveLength(2);
    expect(calls.filter((url) => url.endsWith("/api/v1/deviceToken/refresh"))).toHaveLength(1);
    expect(h.replaceProviderKey).toHaveBeenCalledOnce();
  });

  it("does not refresh or retry a quota rejection", async () => {
    const value = storedKey(storedCredential({ expireTime: Math.floor((Date.now() + 3_600_000) / 1000) }));
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    const fetcher = vi.fn(async () => sse(JSON.stringify({ message: "quota exhausted" }), 403));
    vi.stubGlobal("fetch", fetcher);
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");

    await expect(qoderProvider.stream!(
      { model: "qfmodel:free", messages: [{ role: "user", content: "test" }] },
      { apiKey: value },
      () => {},
    )).rejects.toMatchObject({ status: 403 });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(h.replaceProviderKey).not.toHaveBeenCalled();
  });

  it.each(["content", "reasoning_content"])("does not replay a stream after emitting %s", async (field) => {
    const value = storedKey(storedCredential({ expireTime: Math.floor((Date.now() + 3_600_000) / 1000) }));
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v1/deviceToken/refresh")) return refreshResponse();
      const partial = await sse(JSON.stringify({ choices: [{ delta: { [field]: "partial output" } }] })).text();
      const rejected = await sse(JSON.stringify({ message: "access token expired" }), 401).text();
      return new Response(partial + rejected, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    const onToken = vi.fn();

    await expect(qoderProvider.stream!(
      { model: "qfmodel:free", messages: [{ role: "user", content: "test" }] },
      { apiKey: value },
      onToken,
    )).rejects.toMatchObject({ status: 401 });

    expect(onToken).toHaveBeenCalledExactlyOnceWith("partial output");
    expect(calls.filter((url) => url.includes("agent_chat_generation"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/api/v1/deviceToken/refresh"))).toHaveLength(0);
    expect(h.replaceProviderKey).not.toHaveBeenCalled();
  });
});

describe("Qoder request cancellation", () => {
  it.each(["complete", "stream"] as const)("does not replay a cancelled %s request after an auth rejection", async (operation) => {
    const value = storedKey(storedCredential({ expireTime: Math.floor((Date.now() + 3_600_000) / 1000) }));
    h.keys.push({ id: "qoder-slot", value, createdAt: 1 });
    const controller = new AbortController();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v1/deviceToken/refresh")) return refreshResponse();
      controller.abort();
      return sse(JSON.stringify({ message: "access token expired" }), 401);
    }));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");

    await expect(qoderProvider[operation]!(
      { model: "qfmodel:free", messages: [{ role: "user", content: "test" }], signal: controller.signal },
      { apiKey: value },
      () => {},
    )).rejects.toMatchObject({ status: 401 });

    expect(calls.filter((url) => url.includes("agent_chat_generation"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/api/v1/deviceToken/refresh"))).toHaveLength(0);
    expect(h.replaceProviderKey).not.toHaveBeenCalled();
  });
});
