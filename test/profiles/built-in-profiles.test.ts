import { describe, expect, it } from "vitest";

import { providerIds } from "../../src/types.js";
import {
  builtInProfileLayers,
  directDeepSeekV4Layer,
  providerWireApi,
  resolveBuiltInProfile,
} from "../../src/llm/provider-profiles.js";
import { clearControlRejections } from "../../src/llm/provider-profile.js";

describe("every built-in provider resolves deterministically", () => {
  it.each(providerIds)("resolves %s twice with an identical summary", (id) => {
    clearControlRejections();
    const model = `probe-${id}`;
    const first = resolveBuiltInProfile({ provider: id, model });
    const second = resolveBuiltInProfile({ provider: id, model });
    expect(first).toEqual(second);
    expect(first.route.provider).toBe(id);
    expect(first.route.wireApi).toBe(providerWireApi(id, model));
    expect(first.terminal.naturalEofAccepted).toBe(false);
  });
});

describe("unknown models stay conservative", () => {
  it("assumes nothing model-specific and keeps replay disabled", () => {
    const profile = resolveBuiltInProfile({
      provider: "tokenrouter",
      model: "totally-unknown-model",
    });
    expect(profile.reasoning.control.dialect).toBe("openai-effort");
    expect(profile.reasoning.generation).toBe("unknown");
    expect(profile.reasoning.acceptedEfforts).toHaveLength(0);
    expect(profile.reasoning.replayScope).toBe("none");
  });

  it("falls back to permissive output parsing when the route has no output evidence", () => {
    const profile = resolveBuiltInProfile({
      provider: "openai",
      model: "totally-unknown-model",
    });
    expect(profile.reasoning.outputShapes.length).toBeGreaterThan(3);
  });

  it("does not infer a control dialect from the model name alone", () => {
    const profile = resolveBuiltInProfile({
      provider: "free",
      model: "mystery-hosted-1",
    });
    expect(profile.reasoning.control.dialect).toBe("none");
    expect(profile.reasoning.control.status).toBe("unknown");
  });

  it("treats a documented family id as declared evidence for the dialect", () => {
    const profile = resolveBuiltInProfile({
      provider: "free",
      model: "kimi-k3-mystery-hosted",
    });
    expect(profile.reasoning.control.dialect).toBe("openai-effort");
    expect(profile.reasoning.acceptedEfforts).toEqual(["low", "high", "max"]);
  });
});

describe("deepseek v4 route separation", () => {
  it("direct contract uses the thinking toggle, 1M/384K limits, and cache counters", () => {
    const layer = directDeepSeekV4Layer();
    const profile = resolveBuiltInProfile({
      provider: "custom",
      model: "deepseek-v4-pro",
      endpointHash: "sha256:api-deepseek",
    });
    expect(profile.route.wireApi).toBe("chat-completions");
    expect(layer.reasoning.control!.dialect).toBe("deepseek-thinking");
    expect(layer.reasoning!.disableForm).toBe("thinking-disabled");
    expect(layer.limits!.contextTokens).toBe(1_000_000);
    expect(layer.limits!.outputTokens).toBe(384_000);
    expect(layer.usage!.cachedInput).toContain("usage.prompt_cache_hit_tokens");
    expect(layer.usage!.uncachedInput).toContain(
      "usage.prompt_cache_miss_tokens",
    );
    expect(profile.limits.contextTokens).not.toBe(1_000_000);
    expect(profile.usage.cachedInput ?? []).not.toContain(
      "usage.prompt_cache_hit_tokens",
    );
  });

  it("nvidia hosts v4 through chat-template kwargs, not the direct toggle", () => {
    const profile = resolveBuiltInProfile({
      provider: "nvidia",
      model: "deepseek-v4",
    });
    expect(profile.reasoning.control.dialect).toBe("chat-template-thinking");
    expect(profile.reasoning.acceptedEfforts).toEqual(["none", "high"]);
    expect(profile.reasoning.replayScope).toBe("tool-turn");
  });

  it("openrouter v4 uses nested reasoning and structured details", () => {
    const profile = resolveBuiltInProfile({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
    });
    expect(profile.reasoning.control.dialect).toBe("openai-nested-reasoning");
    expect(profile.reasoning.generation).toBe("default-on");
    expect(profile.reasoning.outputShapes).toContain("structured-details");
  });

  it("fireworks v4 documents effort none with an affinity cache contract", () => {
    const profile = resolveBuiltInProfile({
      provider: "fireworks",
      model: "accounts/fireworks/models/deepseek-v4-pro",
    });
    expect(profile.reasoning.acceptedEfforts).toEqual(["none", "high", "max"]);
    expect(profile.reasoning.disableForm).toBe("effort-none");
    expect(profile.cache.affinityField).toBe("prompt_cache_key");
    expect(profile.cache.cacheAffectingFields).toContain("reasoning_history");
  });

  it("keeps gateway routes on the gateway's own effort control", () => {
    for (const [provider, dialect] of [
      ["tokenrouter", "openai-effort"],
      ["modal", "modal-advertised-effort"],
    ] as const) {
      const profile = resolveBuiltInProfile({
        provider,
        model: "deepseek/deepseek-v4-pro",
      });
      expect(profile.reasoning.generation).toBe("default-on");
      expect(profile.reasoning.control.dialect).toBe(dialect);
    }
  });

  it("keeps the vendor toggle where the endpoint declares it", () => {
    const profile = resolveBuiltInProfile({
      provider: "free",
      model: "deepseek-v4-pro",
    });
    expect(profile.reasoning.control.dialect).toBe("deepseek-thinking");
    expect(profile.reasoning.disableForm).toBe("thinking-disabled");
  });

  it("keeps openrouter on its own normalized control instead of the vendor one", () => {
    const profile = resolveBuiltInProfile({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
    });
    expect(profile.reasoning.control.dialect).toBe("openai-nested-reasoning");
  });
});

describe("kimi preservation matrix", () => {
  it("k3 and k2.7 are mandatory all-history", () => {
    for (const model of ["kimi-k3", "moonshotai/kimi-k2.7-code"]) {
      const profile = resolveBuiltInProfile({ provider: "tokenrouter", model });
      expect(profile.reasoning.generation).toBe("mandatory");
      expect(profile.reasoning.replayScope).toBe("all-history");
      expect(profile.reasoning.finalTurnPreservation).toBe("required");
      expect(profile.reasoning.disableForm).toBe("none-documented");
      expect(profile.outputBudget.mandatoryReasoningReserveTokens).toBeGreaterThan(
        0,
      );
    }
  });

  it("k2.6 preservation is configurable", () => {
    const profile = resolveBuiltInProfile({
      provider: "modal",
      model: "moonshotai/Kimi-K2.6",
    });
    expect(profile.reasoning.replayScope).toBe("configurable");
    expect(profile.reasoning.finalTurnPreservation).toBe("supported");
  });

  it("k2.5 does not preserve thinking", () => {
    const profile = resolveBuiltInProfile({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.5",
    });
    expect(profile.reasoning.replayScope).toBe("tool-turn");
    expect(profile.reasoning.finalTurnPreservation).toBe("unsupported");
  });
});

describe("route-specific contracts", () => {
  it("qwen cloud exposes enable_thinking and configurable preservation", () => {
    const profile = resolveBuiltInProfile({
      provider: "qwen-cloud",
      model: "qwen3.7-plus",
    });
    expect(profile.reasoning.control.dialect).toBe("qwen-enable-thinking");
    expect(profile.reasoning.disableForm).toBe("enable-thinking-false");
    expect(profile.reasoning.replayScope).toBe("configurable");
    expect(profile.reasoning.finalTurnPreservation).toBe("supported");
  });

  it("meta is mandatory with encrypted items and cache affinity", () => {
    const profile = resolveBuiltInProfile({
      provider: "meta",
      model: "muse-spark-1.2",
    });
    expect(profile.reasoning.generation).toBe("mandatory");
    expect(profile.reasoning.disable).toBe("unsupported");
    expect(profile.reasoning.outputShapes).toContain("encrypted-reasoning-items");
    expect(profile.cache.affinityField).toBe("prompt_cache_key");
    expect(profile.terminal.proofs).toContain("response-completed");
  });

  it("anthropic claude-4 thinks optionally; claude-3-5 does not", () => {
    const thinking = resolveBuiltInProfile({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(thinking.reasoning.generation).toBe("optional");
    expect(thinking.reasoning.outputShapes).toContain("signed-thinking-block");
    expect(thinking.route.wireApi).toBe("anthropic-messages");
    const legacy = resolveBuiltInProfile({
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
    });
    expect(legacy.reasoning.generation).toBe("none");
    expect(legacy.reasoning.control.status).toBe("unsupported");
  });

  it("aws-mantle picks the wire api from the model dialect", () => {
    expect(
      providerWireApi("aws-mantle", "anthropic.claude-haiku-4-5"),
    ).toBe("anthropic-messages");
    expect(providerWireApi("aws-mantle", "meta/llama-4-maverick")).toBe(
      "chat-completions",
    );
  });

  it("ollama think is supported only for thinking families", () => {
    const thinking = resolveBuiltInProfile({
      provider: "ollama",
      model: "qwen3:32b",
    });
    expect(thinking.reasoning.control.dialect).toBe("ollama-think");
    expect(thinking.reasoning.control.status).toBe("supported");
    const plain = resolveBuiltInProfile({
      provider: "ollama",
      model: "llama3.1:8b",
    });
    expect(plain.reasoning.control.status).toBe("unknown");
  });

  it("tokenrouter keeps exact namespaced context limits from the catalog", () => {
    const profile = resolveBuiltInProfile({
      provider: "tokenrouter",
      model: "deepseek/deepseek-v4-pro",
    });
    expect(profile.limits.contextTokens).toBe(1_000_000);
    expect(profile.limits.source).toBe("catalog");
  });

  it("modal keeps proxy auth and omits deployment-owned controls", () => {
    const profile = resolveBuiltInProfile({
      provider: "modal",
      model: "moonshotai/Kimi-K3",
    });
    expect(profile.transport.authType).toBe("proxy-headers");
    expect(profile.reasoning.control.dialect).toBe("modal-advertised-effort");
    expect(profile.reasoning.generation).toBe("mandatory");
  });

  it("gemini declares thought signatures with finish-reason terminal", () => {
    const profile = resolveBuiltInProfile({
      provider: "gemini",
      model: "gemini-3.5-flash",
    });
    expect(profile.reasoning.outputShapes).toContain("thought-signature");
    expect(profile.reasoning.disableForm).toBe("thinking-budget-zero");
    expect(profile.terminal.proofs).toEqual(["finish-reason"]);
    expect(profile.usage.cachedInput).toContain(
      "usageMetadata.cachedContentTokenCount",
    );
  });
});

describe("layer composition", () => {
  it("model facts outrank family facts and catalog outranks family", () => {
    const layers = builtInProfileLayers("nvidia", "deepseek-v4");
    expect(layers.builtin?.reasoning?.control?.dialect).toBe(
      "chat-template-thinking",
    );
    expect(layers.family?.capabilities?.tools).toBe("supported");
  });
});
