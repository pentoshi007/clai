import { afterEach, describe, expect, it } from "vitest";
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

describe("phase 7 — free-only provider categories", () => {
  const before = getConfig().freeOnly;
  afterEach(() => updateConfig({ freeOnly: before }));

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
    // Subsequent fallbacks should still drop the other paid provider.
    expect(chain.slice(1)).not.toContain("anthropic");
  });

  it("buildFallbackChain in non-freeOnly mode includes paid providers", () => {
    const chain = buildFallbackChain("nvidia", false, true);
    expect(chain).toContain("openai");
    expect(chain).toContain("anthropic");
  });

  it("provider fallback defaults to the selected provider only", () => {
    expect(buildFallbackChain("groq", false)).toEqual(["groq"]);
  });
});

describe("provider fallback rate limits", () => {
  const originalGroq = providers.groq;
  const originalNvidia = providers.nvidia;
  const beforeFallback = getConfig().providerFallback;
  const beforeGroqKey = process.env.GROQ_API_KEY;
  const beforeNvidiaKey = process.env.NVIDIA_API_KEY;

  afterEach(() => {
    providers.groq = originalGroq;
    providers.nvidia = originalNvidia;
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
          35,
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
    ).rejects.toThrow(/groq: Provider request failed with HTTP 429/);

    expect(nvidiaCalled).toBe(false);
    expect(statuses.join("")).toMatch(/staying on selected provider/);
    expect(statuses.join("")).not.toMatch(/trying next provider/);
  });
});
