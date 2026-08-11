import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerCategory,
  updateConfig,
  getConfig,
} from "../src/store/config.js";
import {
  buildFallbackChain,
  providers,
  streamWithProvider,
} from "../src/llm/router.js";
import { ProviderError } from "../src/llm/http.js";
import type { LlmProvider } from "../src/llm/provider.js";

let groqMultiKey = false;

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (
      provider: Parameters<typeof actual.getProviderKeys>[0],
    ) => {
      const real = await actual.getProviderKeys(provider);
      if (provider === "groq" && groqMultiKey && real.keys.length === 1) {
        return {
          ...real,
          keys: [
            ...real.keys,
            { id: "env-second", value: "gsk_test_second", createdAt: 0 },
          ],
        };
      }
      return real;
    },
  };
});

describe("phase 7 — free-only provider categories", () => {
  const before = getConfig().freeOnly;

  beforeEach(() => {
    // Reset to defaults to prevent cross-test pollution from other files
    updateConfig({ freeOnly: false });
  });

  afterEach(() => {
    updateConfig({ freeOnly: before });
  });

  it("labels each built-in provider with a category", () => {
    expect(providerCategory.nvidia).toBe("free-cloud");
    expect(providerCategory.groq).toBe("free-cloud");
    expect(providerCategory.gemini).toBe("free-cloud");
    expect(providerCategory.openrouter).toBe("free-cloud");
    expect(providerCategory.ollama).toBe("local");
    expect(providerCategory.openai).toBe("paid-cloud");
    expect(providerCategory.anthropic).toBe("paid-cloud");
  });

  it("freeOnly defaults to false and is persisted via updateConfig", () => {
    // Make sure we explicitly start from false
    updateConfig({ freeOnly: false });
    expect(getConfig().freeOnly).toBe(false);
    updateConfig({ freeOnly: true });
    expect(getConfig().freeOnly).toBe(true);
    updateConfig({ freeOnly: false });
    expect(getConfig().freeOnly).toBe(false);
  });

  it("buildFallbackChain in freeOnly mode excludes paid-cloud providers", () => {
    const chain = buildFallbackChain("nvidia", true, true);
    expect(chain).not.toContain("openai");
    expect(chain).not.toContain("anthropic");
    expect(chain[0]).toBe("nvidia");
    expect(chain).toContain("groq");
    expect(chain).toContain("ollama");
  });

  it("buildFallbackChain still honors explicit paid provider as first attempt", () => {
    const chain = buildFallbackChain("openai", true, true);
    expect(chain[0]).toBe("openai");
    expect(chain.slice(1)).not.toContain("anthropic");
  });

  it("buildFallbackChain in non-freeOnly mode includes paid providers", () => {
    const chain = buildFallbackChain("nvidia", false, true);
    expect(chain).toContain("openai");
    expect(chain).toContain("anthropic");
  });

  it("can prefer alternates after a live-stream stall while retaining the selected route", () => {
    const chain = buildFallbackChain("modal", false, true, true);
    expect(chain[0]).not.toBe("modal");
    expect(chain.at(-1)).toBe("modal");
    expect(new Set(chain).size).toBe(chain.length);
  });

  it("provider fallback defaults to the selected provider only", () => {
    expect(buildFallbackChain("groq", false)).toEqual(["groq"]);
  });
});

describe("provider fallback rate limits", () => {
  const originalGroq = providers.groq;
  const originalNvidia = providers.nvidia;
  const originalFree = providers.free;
  const beforeFallback = getConfig().providerFallback;
  const beforeGroqKey = process.env.GROQ_API_KEY;
  const beforeNvidiaKey = process.env.NVIDIA_API_KEY;

  beforeEach(() => {
    updateConfig({ providerFallback: false });
    groqMultiKey = false;
  });

  afterEach(() => {
    providers.groq = originalGroq;
    providers.nvidia = originalNvidia;
    providers.free = originalFree;
    updateConfig({ providerFallback: beforeFallback });
    if (beforeGroqKey === undefined) {
      delete process.env.GROQ_API_KEY;
    } else {
      process.env.GROQ_API_KEY = beforeGroqKey;
    }
    if (beforeNvidiaKey === undefined) {
      delete process.env.NVIDIA_API_KEY;
    } else {
      process.env.NVIDIA_API_KEY = beforeNvidiaKey;
    }
  });

  it("stays on the selected model when it is rate limited, even if fallback is enabled", async () => {
    updateConfig({ providerFallback: true });
    process.env.GROQ_API_KEY = "gsk_test";
    process.env.NVIDIA_API_KEY = "nvapi_test_key_for_router";
    let nvidiaCalled = false;
    providers.groq = {
      ...originalGroq,
      async stream() {
        throw new ProviderError(
          "Provider request failed with HTTP 429 (retry after 35s)",
          429,
          "",
          0.001,
        );
      },
    } as LlmProvider;
    providers.nvidia = {
      ...originalNvidia,
      async stream() {
        nvidiaCalled = true;
        return {
          text: "fallback",
          provider: "nvidia",
          model: "openai/gpt-oss-20b",
        };
      },
    } as LlmProvider;
    const statuses: string[] = [];

    await expect(
      streamWithProvider(
        {
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: "hi" }],
        },
        () => undefined,
        (message) => statuses.push(message),
      ),
    ).rejects.toThrow(
      /No provider could stream the request\. — groq: Model is rate limited[\s\S]*Exact provider error: Provider request failed with HTTP 429 \(retry after 35s\)/,
    );

    expect(nvidiaCalled).toBe(false);
    expect(statuses.join("")).toMatch(/staying on selected provider/);
    expect(statuses.join("")).not.toMatch(/trying next provider/);
  });

  it("stays on the selected model when auth fails, even if fallback is enabled", async () => {
    updateConfig({ providerFallback: true });
    process.env.GROQ_API_KEY = "gsk_test";
    process.env.NVIDIA_API_KEY = "nvapi_test_key_for_router";
    let nvidiaCalled = false;
    providers.groq = {
      ...originalGroq,
      async stream() {
        throw new ProviderError("Provider request failed with HTTP 401 — bad key", 401);
      },
    } as LlmProvider;
    providers.nvidia = {
      ...originalNvidia,
      async stream() {
        nvidiaCalled = true;
        return { text: "fallback", provider: "nvidia", model: "openai/gpt-oss-20b" };
      },
    } as LlmProvider;

    await expect(
      streamWithProvider(
        {
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: "hi" }],
        },
        () => undefined,
      ),
    ).rejects.toThrow(
      /No provider could stream the request\. — groq:.*(401|Authentication|authorization)/i,
    );

    expect(nvidiaCalled).toBe(false);
  });

  it("allows configured fallback after a provider input-limit 413", async () => {
    updateConfig({ providerFallback: true });
    process.env.GROQ_API_KEY = "gsk_test";
    process.env.NVIDIA_API_KEY = "nvapi_test_key_for_router";
    groqMultiKey = true;
    let nvidiaCalled = false;
    providers.groq = {
      ...originalGroq,
      async stream() {
        throw new ProviderError("Provider request failed with HTTP 413", 413);
      },
    } as LlmProvider;
    providers.nvidia = {
      ...originalNvidia,
      async stream() {
        nvidiaCalled = true;
        return { text: "fallback", provider: "nvidia", model: "fallback-model" };
      },
    } as LlmProvider;
    providers.free = {
      ...originalFree,
      async stream() {
        throw new Error("provider returned HTTP 503: service unavailable");
      },
    } as LlmProvider;

    const result = await streamWithProvider(
      {
        provider: "groq",
        // Agent turns opt in to a fallback model even when users selected a
        // non-default model, such as GPT-OSS.
        model: "openai/gpt-oss-20b",
        allowModelFallback: true,
        messages: [{ role: "user", content: "hi" }],
      },
      () => undefined,
    );

    expect(result.text).toBe("fallback");
    expect(nvidiaCalled).toBe(true);
  });
});
