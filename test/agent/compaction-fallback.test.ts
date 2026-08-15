import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";
import type { ProviderAuth } from "../../src/llm/provider.js";
import type { ProviderKeysResult } from "../../src/store/keys.js";

const { openaiComplete, nvidiaComplete, fallbackConfig } = vi.hoisted(() => ({
  openaiComplete: vi.fn(),
  nvidiaComplete: vi.fn(),
  fallbackConfig: { providerFallback: false },
}));

vi.mock("../../src/llm/openai.js", () => ({
  openaiProvider: {
    id: "openai",
    displayName: "OpenAI",
    defaultModel: "gpt-5.4-mini",
    validateKey: () => true,
    ping: async () => undefined,
    complete: (request: CompletionRequest, auth: ProviderAuth) =>
      openaiComplete(request, auth) as Promise<CompletionResult>,
  },
}));

vi.mock("../../src/llm/nvidia.js", () => ({
  nvidiaProvider: {
    id: "nvidia",
    displayName: "NVIDIA NIM",
    defaultModel: "openai/gpt-oss-20b",
    validateKey: () => true,
    ping: async () => undefined,
    complete: (request: CompletionRequest, auth: ProviderAuth) =>
      nvidiaComplete(request, auth) as Promise<CompletionResult>,
  },
}));

vi.mock("../../src/llm/free.js", () => ({
  freeProvider: {
    id: "free",
    displayName: "Free (zen + kilo)",
    defaultModel: "free-1/deepseek-v4-flash-free",
    validateKey: () => true,
    ping: async () => undefined,
    complete: async () => {
      throw new Error("provider returned HTTP 503: service unavailable");
    },
  },
}));

vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      defaultProvider: "openai",
      providerFallback: fallbackConfig.providerFallback,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
  };
});

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  const multiFor = (provider: string): ProviderKeysResult => ({
    keys: [
      { id: "k1", value: `sk-${provider}-testkey`, createdAt: 0 },
      { id: "k2", value: `sk-${provider}-testkey-2`, createdAt: 0 },
    ],
    activeIndex: 0,
    source: "fallback",
  });
  return {
    ...actual,
    getProviderKeys: async (provider: "openai" | "nvidia" | string) =>
      multiFor(provider),
    getProviderSecret: async (provider: string) => ({
      value: `sk-${provider}-testkey`,
      source: "fallback" as const,
    }),
    markProviderKeySuccess: async () => undefined,
  };
});

function compactionRequest(
  allowModelFallback?: boolean,
): CompletionRequest {
  return {
    provider: "openai",
    model: "custom-503-model",
    messages: [
      { role: "system", content: "Summarize for compaction" },
      { role: "user", content: "Summarize this" },
    ],
    temperature: 0.1,
    maxTokens: 4096,
    ...(allowModelFallback === undefined ? {} : { allowModelFallback }),
  };
}

describe("compaction provider fallback", () => {
  beforeEach(() => {
    openaiComplete.mockReset();
    nvidiaComplete.mockReset();
    fallbackConfig.providerFallback = false;
    nvidiaComplete.mockResolvedValue({
      text: "nvidia-ok",
      provider: "nvidia",
      model: "openai/gpt-oss-20b",
      finishReason: "stop",
    } satisfies CompletionResult);
  });

  it("falls back to another provider's model on 503 only when provider fallback is enabled, with a single attempt", async () => {
    fallbackConfig.providerFallback = true;
    openaiComplete.mockRejectedValue(
      new Error("provider returned HTTP 503: service unavailable"),
    );

    const { completeWithProvider } = await import("../../src/llm/router.js");
    const result = await completeWithProvider(compactionRequest(true), {
      maxRetries: 0,
    });

    expect(result.provider).toBe("nvidia");
    expect(result.text).toBe("nvidia-ok");
    expect(openaiComplete).toHaveBeenCalledTimes(1);
    expect(nvidiaComplete).toHaveBeenCalledTimes(1);
  });

  it("does not fall back without the per-request flag when providerFallback is off", async () => {
    openaiComplete.mockRejectedValue(
      new Error("provider returned HTTP 503: service unavailable"),
    );

    const { completeWithProvider } = await import("../../src/llm/router.js");
    await expect(
      completeWithProvider(compactionRequest(), { maxRetries: 0 }),
    ).rejects.toThrow(/503|No provider could complete/i);
    expect(nvidiaComplete).not.toHaveBeenCalled();
  });

  it("never switches providers on failure when providerFallback is off, even with allowModelFallback", async () => {
    openaiComplete.mockRejectedValue(
      new Error("provider returned HTTP 503: service unavailable"),
    );

    const { completeWithProvider } = await import("../../src/llm/router.js");
    await expect(
      completeWithProvider(compactionRequest(true), { maxRetries: 0 }),
    ).rejects.toThrow(/503|No provider could complete/i);
    expect(nvidiaComplete).not.toHaveBeenCalled();
  });
});
