import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLINE_REQUEST_HEADERS, ClineAuthError } from "../src/llm/cline-auth.js";
import type { CompletionRequest } from "../src/types.js";

const h = vi.hoisted(() => ({
  oldKey: "workos:old-token-aaaaaaaaaaaaaaaa",
  freshKey: "workos:fresh-token-bbbbbbbbbbbbbbbb",
  refresh: vi.fn(),
  replaceProviderKey: vi.fn(),
}));

vi.mock("../src/llm/cline-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/cline-auth.js")>();
  return { ...actual, refreshClineToken: h.refresh };
});

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) =>
      provider === "cline"
        ? {
            keys: [{ id: "cline-key", value: h.oldKey, createdAt: 0 }],
            activeIndex: 0,
            source: "fallback" as const,
          }
        : { keys: [], activeIndex: 0, source: "missing" as const },
    replaceProviderKey: h.replaceProviderKey,
  };
});

function request(): CompletionRequest {
  return {
    provider: "cline",
    model: "cline-free/kimi-k3",
    messages: [{ role: "user", content: "hi" }],
  };
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error:
        "Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.",
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: "not entitled" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(): Response {
  return new Response(
    'data: {"choices":[{"delta":{"content":"renewed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function requestHeaders(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit;
  return init.headers as Record<string, string>;
}

function authorization(call: unknown[]): string {
  return requestHeaders(call).authorization ?? "";
}

describe("Cline token refresh", () => {
  beforeEach(() => {
    h.refresh.mockReset().mockResolvedValue({
      accessToken: h.freshKey,
      refreshToken: "refresh-token-next",
      expiresAt: 123,
    });
    h.replaceProviderKey.mockReset().mockResolvedValue(true);
  });

  it("refreshes and retries a streaming request after a Cline 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(streamResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { clineProvider } = await import("../src/llm/cline.js");
    const tokens: string[] = [];
    const statuses: string[] = [];
    const result = await clineProvider.stream!(
      request(),
      {
        apiKey: h.oldKey,
        refreshToken: "refresh-token-old",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      (token) => {
        tokens.push(token);
      },
      (status) => statuses.push(status),
    );

    expect(result.text).toBe("renewed");
    expect(statuses).toEqual([
      "ℹ Cline authentication rejected — refreshing token",
      "ℹ Cline token refreshed — retrying request",
    ]);
    expect(tokens).toEqual(["renewed"]);
    expect(h.refresh).toHaveBeenCalledWith("refresh-token-old");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorization(fetchMock.mock.calls[0]!)).toBe(`Bearer ${h.oldKey}`);
    expect(requestHeaders(fetchMock.mock.calls[0]!)).toMatchObject(CLINE_REQUEST_HEADERS);
    expect(requestHeaders(fetchMock.mock.calls[0]!)["X-Task-ID"]).toBeDefined();
    expect(authorization(fetchMock.mock.calls[1]!)).toBe(`Bearer ${h.freshKey}`);
    expect(requestHeaders(fetchMock.mock.calls[1]!)).toMatchObject(CLINE_REQUEST_HEADERS);
    expect(h.replaceProviderKey).toHaveBeenCalledWith(
      "cline",
      h.oldKey,
      h.freshKey,
      { refreshToken: "refresh-token-next", expiresAt: 123 },
    );
  });

  it("does not refresh a Cline 403 entitlement failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(forbidden());
    vi.stubGlobal("fetch", fetchMock);

    const { clineProvider } = await import("../src/llm/cline.js");
    await expect(clineProvider.complete!(request(), { apiKey: h.oldKey })).rejects.toThrow(
      /not entitled/,
    );

    expect(h.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send the stale key when Cline rejects refresh with invalid_grant", async () => {
    const invalidGrant = new ClineAuthError("Cline token refresh failed: invalid_grant", 400, "invalid_grant");
    h.refresh.mockRejectedValueOnce(invalidGrant);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { clineProvider } = await import("../src/llm/cline.js");
    await expect(clineProvider.complete!(request(), {
      apiKey: h.oldKey,
      refreshToken: "refresh-token-old",
      expiresAt: Date.now() + 60_000,
    })).rejects.toBe(invalidGrant);

    expect(h.refresh).toHaveBeenCalledWith("refresh-token-old");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.replaceProviderKey).not.toHaveBeenCalled();
  });

  it("refreshes credentials before ping and sends current identity headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { clineProvider } = await import("../src/llm/cline.js");
    await clineProvider.ping!({
      apiKey: h.oldKey,
      refreshToken: "refresh-token-old",
      expiresAt: Date.now() + 60_000,
    });

    expect(h.refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(authorization(fetchMock.mock.calls[0]!)).toBe(`Bearer ${h.freshKey}`);
    expect(requestHeaders(fetchMock.mock.calls[0]!)).toMatchObject(CLINE_REQUEST_HEADERS);
    expect(requestHeaders(fetchMock.mock.calls[0]!)['X-Task-ID']).toBeDefined();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.cline.bot/api/v1/users/me");
  });

  it("refreshes credentials before authenticated model listing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      recommended: [],
      free: [],
      clinePass: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { clineProvider } = await import("../src/llm/cline.js");
    await expect(clineProvider.listModels!({
      apiKey: h.oldKey,
      refreshToken: "refresh-token-old",
      expiresAt: Date.now() + 60_000,
    })).resolves.toEqual([]);

    expect(h.refresh).toHaveBeenCalledOnce();
    expect(authorization(fetchMock.mock.calls[0]!)).toBe(`Bearer ${h.freshKey}`);
    expect(requestHeaders(fetchMock.mock.calls[0]!)).toMatchObject(CLINE_REQUEST_HEADERS);
  });

  it("shares concurrent token refresh and persists rotated credentials once", async () => {
    let markStarted: () => void = () => {};
    let finishRefresh: (tokens: { accessToken: string; refreshToken: string; expiresAt: number }) => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    h.refresh.mockImplementation(() => {
      markStarted();
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      id: "res-1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { clineProvider } = await import("../src/llm/cline.js");
    const auth = {
      apiKey: h.oldKey,
      refreshToken: "refresh-token-shared",
      expiresAt: Date.now() + 60_000,
    };
    const first = clineProvider.complete!(request(), auth);
    const second = clineProvider.complete!(request(), auth);
    await started;
    expect(h.refresh).toHaveBeenCalledOnce();
    finishRefresh({
      accessToken: h.freshKey,
      refreshToken: "refresh-token-rotated",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.text)).toEqual(["ok", "ok"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.replaceProviderKey).toHaveBeenCalledOnce();
    expect(h.replaceProviderKey).toHaveBeenCalledWith(
      "cline",
      h.oldKey,
      h.freshKey,
      { refreshToken: "refresh-token-rotated", expiresAt: expect.any(Number) },
    );
  });
});
