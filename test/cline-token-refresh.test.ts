import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../src/types.js";

const h = vi.hoisted(() => ({
  oldKey: "workos:old-token-aaaaaaaaaaaaaaaa",
  freshKey: "workos:fresh-token-bbbbbbbbbbbbbbbb",
  refresh: vi.fn(),
  replaceProviderKey: vi.fn(),
}));

vi.mock("../src/llm/cline-auth.js", () => ({
  CLINE_API_BASE_URL: "https://api.cline.bot/api/v1",
  CLINE_REQUEST_HEADERS: { "X-CLIENT-TYPE": "cline-desktop" },
  maybeRefreshClineToken: h.refresh,
}));

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

function authorization(call: unknown[]): string {
  const init = call[1] as RequestInit;
  return (init.headers as Record<string, string>).authorization ?? "";
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
      { apiKey: h.oldKey },
      (token) => {
        tokens.push(token);
      },
      (status) => statuses.push(status),
    );

    expect(result.text).toBe("renewed");
    expect(statuses).toEqual([
      "ℹ Cline authentication expired — refreshing token",
      "ℹ Cline token refreshed — retrying request",
    ]);
    expect(tokens).toEqual(["renewed"]);
    expect(h.refresh).toHaveBeenCalledWith(
      h.oldKey,
      undefined,
      expect.any(Function),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorization(fetchMock.mock.calls[0]!)).toBe(`Bearer ${h.oldKey}`);
    expect(authorization(fetchMock.mock.calls[1]!)).toBe(`Bearer ${h.freshKey}`);
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
});
