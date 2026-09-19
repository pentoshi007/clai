import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../src/types.js";

const KEY_ONE = "workos:key-one-aaaaaaaaaaaaaaaa";
const KEY_TWO = "workos:key-two-bbbbbbbbbbbbbbbb";

let clineKeys: Array<{ id: string; value: string; createdAt: number }> = [];

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => {
      if (provider === "cline") {
        return { keys: clineKeys, activeIndex: 0, source: "fallback" as const };
      }
      return { keys: [], activeIndex: 0, source: "missing" as const };
    },
    getProviderSecret: async (provider: string) =>
      provider === "cline"
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
      defaultProvider: "cline",
      defaultModel: "cline-free/deepseek-v4.1-flash",
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
    provider: "cline",
    model: "cline-free/deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
  };
}

function okCompletion() {
  return new Response(
    JSON.stringify({
      data: {
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content: "rotated-ok" } },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
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

function authHeaderOf(call: unknown[]): string {
  const init = call[1] as RequestInit;
  const headers = init.headers as Record<string, string>;
  return headers.authorization ?? headers.Authorization ?? "";
}

describe("Cline multi-key rotation", () => {
  beforeEach(() => {
    clineKeys = [
      { id: "c1", value: KEY_ONE, createdAt: 0 },
      { id: "c2", value: KEY_TWO, createdAt: 0 },
    ];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("switches to the next key when the first is rate limited", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.authorization === `Bearer ${KEY_ONE}`) {
        return errorResponse(429, "rate limited");
      }
      return okCompletion();
    });
    vi.stubGlobal("fetch", fetchMock);

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), {
      maxRetries: 0,
      retryRateLimits: false,
      allowProviderFallback: false,
      adoptFallback: false,
    });

    expect(result.text).toBe("rotated-ok");
    const used = fetchMock.mock.calls.map((call) => authHeaderOf(call));
    expect(used).toContain(`Bearer ${KEY_ONE}`);
    expect(used).toContain(`Bearer ${KEY_TWO}`);
  });

  it("switches to the next key on an auth error", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.authorization === `Bearer ${KEY_ONE}`) {
        return errorResponse(401, "unauthorized");
      }
      return okCompletion();
    });
    vi.stubGlobal("fetch", fetchMock);

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), {
      maxRetries: 0,
      allowProviderFallback: false,
      adoptFallback: false,
    });

    expect(result.text).toBe("rotated-ok");
    const used = fetchMock.mock.calls.map((call) => authHeaderOf(call));
    expect(used).toContain(`Bearer ${KEY_TWO}`);
  });

  it("switches to the next key on an insufficient-credits error", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.authorization === `Bearer ${KEY_ONE}`) {
        return errorResponse(402, "insufficient credits");
      }
      return okCompletion();
    });
    vi.stubGlobal("fetch", fetchMock);

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), {
      maxRetries: 0,
      allowProviderFallback: false,
      adoptFallback: false,
    });

    expect(result.text).toBe("rotated-ok");
    const used = fetchMock.mock.calls.map((call) => authHeaderOf(call));
    expect(used).toContain(`Bearer ${KEY_TWO}`);
  });
});
