import { afterEach, describe, expect, it } from "vitest";
import {
  providerCategory,
  updateConfig,
  getConfig,
} from "../src/store/config.js";
import { buildFallbackChain } from "../src/llm/router.js";

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
