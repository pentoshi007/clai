import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  builtInProfileLayers,
  catalogProfileLayer,
  resolveBuiltInProfile,
} from "../../src/llm/provider-profiles.js";
import {
  displayReasoningEfforts,
  registerModelCatalogFacts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { clearControlRejections } from "../../src/llm/provider-profile.js";
import { parseCatalogFacts } from "../../src/llm/catalog-facts.js";

const KIMI_K3_OPENROUTER = {
  id: "moonshotai/kimi-k3",
  reasoning: {
    mandatory: false,
    default_enabled: true,
    supported_efforts: ["max", "high", "low"],
    default_effort: "max",
  },
  context_length: 1_048_576,
  top_provider: { context_length: 1_048_576, max_completion_tokens: null },
  default_parameters: { temperature: null, top_p: 0.95 },
  supported_parameters: ["reasoning", "reasoning_effort", "max_tokens", "temperature"],
  architecture: { input_modalities: ["text", "image"] },
};

beforeEach(() => {
  resetReasoningKnowledge();
  clearControlRejections();
});

afterEach(() => {
  resetReasoningKnowledge();
});

describe("catalogProfileLayer", () => {
  it("projects reasoning, limits, parameters and sampling out of catalog facts", () => {
    const facts = parseCatalogFacts(KIMI_K3_OPENROUTER)!;
    const layer = catalogProfileLayer(facts)!;
    expect(layer.evidence.source).toBe("catalog");
    expect(layer.reasoning?.generation).toBe("default-on");
    expect(layer.reasoning?.acceptedEfforts).toEqual(["max", "high", "low"]);
    expect(layer.reasoning?.defaultEffort).toBe("max");
    expect(layer.reasoning?.disable).toBe("supported");
    expect(layer.capabilities?.acceptedParameters).toContain("reasoning_effort");
    expect(layer.limits?.contextTokens).toBe(1_048_576);
    expect(layer.sampling?.omit).toEqual(["temperature"]);
    expect(layer.sampling?.defaults).toEqual({ top_p: 0.95 });
  });

  it("marks a mandatory-reasoning model as undisableable", () => {
    const layer = catalogProfileLayer(
      parseCatalogFacts({ id: "qwen/qwen3.8-max", reasoning: { mandatory: true } })!,
    )!;
    expect(layer.reasoning?.generation).toBe("mandatory");
    expect(layer.reasoning?.disable).toBe("unsupported");
  });

  it("produces no layer for a bare catalog entry", () => {
    expect(catalogProfileLayer(parseCatalogFacts({ id: "bare" })!)).toBeUndefined();
  });
});

describe("catalog facts reach the resolved profile per facet", () => {
  it("takes accepted efforts from the catalog while keeping the family dialect", () => {
    const withoutCatalog = resolveBuiltInProfile({
      provider: "openrouter",
      model: "moonshotai/kimi-k3",
    });
    registerModelCatalogFacts("openrouter", parseCatalogFacts(KIMI_K3_OPENROUTER)!);
    const withCatalog = resolveBuiltInProfile({
      provider: "openrouter",
      model: "moonshotai/kimi-k3",
    });
    expect(withCatalog.reasoning.acceptedEfforts).toEqual(["max", "high", "low"]);
    expect(withCatalog.reasoning.control.dialect).toBe(
      withoutCatalog.reasoning.control.dialect,
    );
    expect(withCatalog.capabilities.acceptedParameters).toContain("reasoning_effort");
    expect(withCatalog.sampling.omit).toEqual(["temperature"]);
    expect(withCatalog.limits.contextTokens).toBe(1_048_576);
  });

  it("keys facts on provider:model so another route never borrows them", () => {
    registerModelCatalogFacts("openrouter", parseCatalogFacts(KIMI_K3_OPENROUTER)!);
    expect(builtInProfileLayers("openrouter", "moonshotai/kimi-k3").catalog).toBeDefined();
    expect(builtInProfileLayers("tokenrouter", "moonshotai/kimi-k3").catalog).toBeUndefined();
    const borrowed = resolveBuiltInProfile({
      provider: "tokenrouter",
      model: "moonshotai/kimi-k3",
    });
    expect(borrowed.capabilities.acceptedParameters).toBeUndefined();
  });

  it("lets a gateway context override outrank the catalog's served window", () => {
    registerModelCatalogFacts(
      "tokenrouter",
      parseCatalogFacts({ id: "deepseek/deepseek-v4-pro", context_length: 131_072 })!,
    );
    const profile = resolveBuiltInProfile({
      provider: "tokenrouter",
      model: "deepseek/deepseek-v4-pro",
    });
    expect(profile.limits.contextTokens).not.toBe(131_072);
  });
});

describe("meta effort vocabulary follows the live catalog", () => {
  it("advertises no fixed list until the provider sends one", () => {
    const profile = resolveBuiltInProfile({
      provider: "meta",
      model: "muse-spark-1.2",
    });
    expect(profile.reasoning.acceptedEfforts).toEqual([]);
    expect(displayReasoningEfforts("meta", "muse-spark-1.2")).toBeUndefined();
  });

  it("scopes efforts to what the catalog advertises for the model", () => {
    registerModelCatalogFacts(
      "meta",
      parseCatalogFacts({
        id: "muse-spark-1.2",
        reasoning: { supported_efforts: ["low", "high"] },
      })!,
    );
    const profile = resolveBuiltInProfile({
      provider: "meta",
      model: "muse-spark-1.2",
    });
    expect(profile.reasoning.acceptedEfforts).toEqual(["low", "high"]);
    expect(displayReasoningEfforts("meta", "muse-spark-1.2")).toEqual([
      "low",
      "high",
    ]);
  });
});
