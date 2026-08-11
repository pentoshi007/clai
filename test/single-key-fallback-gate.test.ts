import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "../src/types.js";
import type { ProviderAuth } from "../src/llm/provider.js";
import { ProviderError } from "../src/llm/http.js";

const NVIDIA_KEY = "nvapi-single";
const NVIDIA_KEY2 = "nvapi-second";
const GROQ_KEY = "gsk_fallback";

const nvidiaComplete = vi.fn();
const groqComplete = vi.fn();

vi.mock("../src/llm/nvidia.js", () => ({
  nvidiaProvider: {
    id: "nvidia",
    displayName: "NVIDIA",
    defaultModel: "moonshotai/Kimi-K2.6",
    validateKey: () => true,
    ping: async () => undefined,
    complete: (request: CompletionRequest, auth: ProviderAuth) =>
      nvidiaComplete(request, auth) as Promise<CompletionResult>,
  },
}));

vi.mock("../src/llm/groq.js", () => ({
  groqProvider: {
    id: "groq",
    displayName: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    validateKey: () => true,
    ping: async () => undefined,
    complete: (request: CompletionRequest, auth: ProviderAuth) =>
      groqComplete(request, auth) as Promise<CompletionResult>,
  },
}));

let nvidiaKeys: Array<{ id: string; value: string; createdAt: number }> = [];
let groqKeys: Array<{ id: string; value: string; createdAt: number }> = [];

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => {
      if (provider === "nvidia") {
        return { keys: nvidiaKeys, activeIndex: 0, source: "fallback" };
      }
      if (provider === "groq") {
        return { keys: groqKeys, activeIndex: 0, source: "fallback" };
      }
      return { keys: [], activeIndex: 0, source: "missing" };
    },
    getProviderSecret: async () => ({
      value: NVIDIA_KEY,
      source: "fallback" as const,
    }),
    markProviderKeySuccess: async () => undefined,
  };
});

vi.mock("../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      defaultProvider: "nvidia",
      defaultModel: "moonshotai/Kimi-K2.6",
      providerFallback: true,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
    providerUsesEndpoints: () => false,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
  };
});

function request(): CompletionRequest {
  return {
    provider: "nvidia",
    model: "moonshotai/Kimi-K2.6",
    messages: [{ role: "user", content: "hi" }],
  };
}

function groqOk(): CompletionResult {
  return {
    text: "groq-ok",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    finishReason: "stop",
  };
}

describe("single-key provider fallback gate", () => {
  beforeEach(() => {
    nvidiaComplete.mockReset();
    groqComplete.mockReset();
    groqKeys = [{ id: "g1", value: GROQ_KEY, createdAt: 0 }];
  });

  it("does not switch provider/model when the requested provider has one API key", async () => {
    nvidiaKeys = [{ id: "n1", value: NVIDIA_KEY, createdAt: 0 }];
    nvidiaComplete.mockRejectedValue(new ProviderError("server error", 500));

    const { completeWithProvider } = await import("../src/llm/router.js");
    await expect(
      completeWithProvider(request(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(nvidiaComplete).toHaveBeenCalled();
    expect(groqComplete).not.toHaveBeenCalled();
  });

  it("still falls back when the requested provider has multiple keys", async () => {
    nvidiaKeys = [
      { id: "n1", value: NVIDIA_KEY, createdAt: 0 },
      { id: "n2", value: NVIDIA_KEY2, createdAt: 0 },
    ];
    nvidiaComplete.mockRejectedValue(new ProviderError("server error", 500));
    groqComplete.mockResolvedValue(groqOk());

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), { maxRetries: 0 });

    expect(result.text).toBe("groq-ok");
    expect(groqComplete).toHaveBeenCalled();
  });
});