import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../src/types.js";
import { invalidateCopilotApiToken } from "../src/llm/copilot-auth.js";

const KEY_ONE = "ghu_keyoneaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_TWO = "ghu_keytwobbbbbbbbbbbbbbbbbbbbbbbb";
const TID_ONE = "tid=one;exp=9999999999;sku=test";
const TID_TWO = "tid=two;exp=9999999999;sku=test";

let copilotKeys: Array<{ id: string; value: string; createdAt: number }> = [];

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => {
      if (provider === "copilot") {
        return { keys: copilotKeys, activeIndex: 0, source: "fallback" as const };
      }
      return { keys: [], activeIndex: 0, source: "missing" as const };
    },
    getProviderSecret: async (provider: string) =>
      provider === "copilot"
        ? { value: KEY_ONE, source: "fallback" as const }
        : { value: undefined, source: "missing" as const },
    markProviderKeySuccess: async () => undefined,
    setProviderKeys: async () => "fallback" as const,
  };
});

vi.mock("../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      defaultProvider: "copilot",
      defaultModel: "gpt-4o",
      providerFallback: false,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
    providerUsesEndpoints: () => false,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
  };
});

function request(): CompletionRequest {
  return {
    provider: "copilot",
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  };
}

function tokenExchange(token: string) {
  return new Response(
    JSON.stringify({
      token,
      expires_at: 9999999999,
      refresh_in: 1500,
      endpoints: { api: "https://api.githubcopilot.com" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function okCompletion() {
  return new Response(
    JSON.stringify({
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: "rotated-ok" } },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(failTidOneWith: number) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/copilot_internal/v2/token")) {
      const headers = init?.headers as Record<string, string>;
      const auth = headers.authorization ?? headers.Authorization ?? "";
      if (auth.includes(KEY_ONE)) return tokenExchange(TID_ONE);
      return tokenExchange(TID_TWO);
    }
    const headers = init?.headers as Record<string, string>;
    const auth = headers.authorization ?? headers.Authorization ?? "";
    if (auth === `Bearer ${TID_ONE}`) {
      return errorResponse(failTidOneWith, "first key failed");
    }
    return okCompletion();
  });
}

function authHeadersOf(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => {
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    return headers.authorization ?? headers.Authorization ?? "";
  });
}

describe("Copilot multi-key rotation", () => {
  beforeEach(() => {
    copilotKeys = [
      { id: "c1", value: KEY_ONE, createdAt: 0 },
      { id: "c2", value: KEY_TWO, createdAt: 0 },
    ];
    invalidateCopilotApiToken(KEY_ONE);
    invalidateCopilotApiToken(KEY_TWO);
  });

  afterEach(() => {
    invalidateCopilotApiToken(KEY_ONE);
    invalidateCopilotApiToken(KEY_TWO);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("switches to the next key when the first is rate limited", async () => {
    const fetchMock = installFetch(429);
    vi.stubGlobal("fetch", fetchMock);

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), {
      maxRetries: 0,
      retryRateLimits: false,
      allowProviderFallback: false,
      adoptFallback: false,
    });

    expect(result.text).toBe("rotated-ok");
    const used = authHeadersOf(fetchMock);
    expect(used).toContain(`Bearer ${TID_ONE}`);
    expect(used).toContain(`Bearer ${TID_TWO}`);
  });

  it("switches to the next key on an auth error", async () => {
    const fetchMock = installFetch(401);
    vi.stubGlobal("fetch", fetchMock);

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), {
      maxRetries: 0,
      allowProviderFallback: false,
      adoptFallback: false,
    });

    expect(result.text).toBe("rotated-ok");
    const used = authHeadersOf(fetchMock);
    expect(used).toContain(`Bearer ${TID_TWO}`);
  });

  it("switches to the next key on an insufficient-credits error", async () => {
    const fetchMock = installFetch(402);
    vi.stubGlobal("fetch", fetchMock);

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), {
      maxRetries: 0,
      allowProviderFallback: false,
      adoptFallback: false,
    });

    expect(result.text).toBe("rotated-ok");
    const used = authHeadersOf(fetchMock);
    expect(used).toContain(`Bearer ${TID_TWO}`);
  });
});
