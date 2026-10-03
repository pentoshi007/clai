import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../src/types.js";
import { disposeFreebuffSessionManager } from "../src/llm/freebuff-session.js";

const KEY_ONE = "freebuff-key-one-aaaaaaaaaaaaaaaa";
const KEY_TWO = "freebuff-key-two-bbbbbbbbbbbbbbbb";

let freebuffKeys: Array<{ id: string; value: string; createdAt: number }> = [];

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => {
      if (provider === "freebuff") {
        return { keys: freebuffKeys, activeIndex: 0, source: "fallback" as const };
      }
      return { keys: [], activeIndex: 0, source: "missing" as const };
    },
    getProviderSecret: async (provider: string) =>
      provider === "freebuff"
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
      defaultProvider: "freebuff",
      defaultModel: "deepseek/deepseek-v4-flash",
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
    provider: "freebuff",
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
  };
}

describe("Freebuff multi-key rotation", () => {
  beforeEach(() => {
    freebuffKeys = [
      { id: "f1", value: KEY_ONE, createdAt: 0 },
      { id: "f2", value: KEY_TWO, createdAt: 0 },
    ];
  });

  afterEach(async () => {
    await disposeFreebuffSessionManager();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rotates to the next key on a 401 instead of short-circuiting locally", async () => {
    const usedKeys: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.includes(KEY_ONE)) {
        usedKeys.push("one");
        return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
      }
      usedKeys.push("two");
      if (url.includes("/freebuff/session/admission")) {
        return new Response(JSON.stringify({ status: "active", instanceId: "cli:rotation", model: "deepseek/deepseek-v4-flash", remainingMs: 3_600_000 }), { status: 200 });
      }
      if (url.includes("/agent-runs")) {
        return new Response(JSON.stringify({ runId: "run-rotate" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "pong" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), {
      maxRetries: 0,
      retryRateLimits: false,
      allowProviderFallback: false,
      adoptFallback: false,
    });
    expect(result.text).toBe("pong");
    expect(usedKeys).toContain("one");
    expect(usedKeys).toContain("two");
  });
});
