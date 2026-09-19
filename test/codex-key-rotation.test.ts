import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../src/types.js";
import { encodeCodexKey } from "../src/llm/codex-auth.js";

const ACC_ONE = "acc-one-aaaaaaaaaaaaaaaa";
const ACC_TWO = "acc-two-bbbbbbbbbbbbbbbb";
const KEY_ONE = encodeCodexKey({ accessToken: ACC_ONE, accountId: "acct-one" });
const KEY_TWO = encodeCodexKey({ accessToken: ACC_TWO, accountId: "acct-two" });

let codexKeys: Array<{ id: string; value: string; createdAt: number }> = [];

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => {
      if (provider === "codex") {
        return { keys: codexKeys, activeIndex: 0, source: "fallback" as const };
      }
      return { keys: [], activeIndex: 0, source: "missing" as const };
    },
    getProviderSecret: async (provider: string) =>
      provider === "codex"
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
      defaultProvider: "codex",
      defaultModel: "gpt-5.1-codex",
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
    provider: "codex",
    model: "gpt-5.1-codex",
    messages: [{ role: "user", content: "hi" }],
  };
}

function okResponses() {
  return new Response(
    JSON.stringify({
      id: "resp_rotation",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "rotated-ok" }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
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

describe("Codex multi-key rotation", () => {
  beforeEach(() => {
    codexKeys = [
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
      if (headers.authorization === `Bearer ${ACC_ONE}`) {
        return errorResponse(429, "rate limited");
      }
      return okResponses();
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
    expect(used).toContain(`Bearer ${ACC_ONE}`);
    expect(used).toContain(`Bearer ${ACC_TWO}`);
  });

  it("switches to the next key on an auth error", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.authorization === `Bearer ${ACC_ONE}`) {
        return errorResponse(401, "unauthorized");
      }
      return okResponses();
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
    expect(used).toContain(`Bearer ${ACC_TWO}`);
  });

  it("switches to the next key on an insufficient-credits error", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.authorization === `Bearer ${ACC_ONE}`) {
        return errorResponse(402, "insufficient credits");
      }
      return okResponses();
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
    expect(used).toContain(`Bearer ${ACC_TWO}`);
  });
});
