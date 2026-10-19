import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearModelCatalogFacts,
  clearModelVisionCapabilities,
  displayReasoningEfforts,
  modelCatalogFacts,
  modelReasoningEfforts,
  modelSupportsThinking,
  modelSupportsVision,
  registerModelCatalog,
  resetReasoningKnowledge,
  resolveToolDialect,
  routeReasoningIsMandatory,
} from "../../src/llm/capabilities.js";
import { withModelCatalogFacts } from "../../src/llm/catalog-context.js";
import { modelMaxOutputTokens, resolveContextWindow } from "../../src/llm/context-windows.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { RIVER_DEFAULT_MODEL, RIVER_GLM_MODEL, riverModelCatalog } from "../../src/llm/river-models.js";

beforeEach(() => {
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
});
afterEach(() => {
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
});

describe("River model facts", () => {
  it.each([
    [RIVER_DEFAULT_MODEL, ["none", "high", "max"], 384_000, false],
    ["deepseek-ai/DeepSeek-V4.1-Flash-1017", ["none", "high", "max"], 384_000, false],
    [RIVER_GLM_MODEL, ["low", "high", "max"], 128_000, true],
  ] as const)("provides documented capabilities before discovery for %s", (model, efforts, output, mandatory) => {
    expect(modelReasoningEfforts("river", model)).toEqual(efforts);
    expect(modelSupportsThinking("river", model)).toBe(true);
    expect(routeReasoningIsMandatory("river", model)).toBe(mandatory);
    expect(modelSupportsVision("river", model)).toBe(true);
    expect(resolveToolDialect("river", model)).toBe("openai");
    expect(resolveContextWindow({ provider: "river", model })).toMatchObject({ tokens: 1_048_576, source: "provider" });
    expect(modelMaxOutputTokens("river", model)).toBe(output);
    const profile = resolveBuiltInProfile({ provider: "river", model });
    expect(profile.reasoning.control.dialect).toBe("openai-effort");
    expect(profile.reasoning.acceptedEfforts).toEqual(efforts);
    expect(profile.cache.kind).toBe("automatic-prefix");
  });

  it("accepts bare IDs, data and models containers, deduplicating malformed entries", () => {
    for (const payload of [
      [RIVER_DEFAULT_MODEL, null, {}, "", RIVER_DEFAULT_MODEL],
      { data: [{ id: RIVER_DEFAULT_MODEL }, { id: RIVER_DEFAULT_MODEL }] },
      { models: [{ name: RIVER_DEFAULT_MODEL }] },
    ]) {
      const models = riverModelCatalog(payload);
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({ id: RIVER_DEFAULT_MODEL, vision: true, reasoningEfforts: ["none", "high", "max"] });
    }
    expect(riverModelCatalog({ error: "unavailable" })).toEqual([]);
  });

  it.each([RIVER_DEFAULT_MODEL, "deepseek-ai/DeepSeek-V4.1-Flash-1017"])("gives live metadata precedence for %s", (model) => {
    const models = riverModelCatalog({ data: [{
      id: model,
      context_length: 800_000,
      max_output_tokens: 64_000,
      reasoning: { supported_efforts: ["none", "low", "high"], default_effort: "low" },
      capabilities: { vision: false, function_calling: false },
    }] });
    registerModelCatalog("river", models);
    expect(modelCatalogFacts("river", model)).toMatchObject({
      contextTokens: 800_000,
      maxOutputTokens: 64_000,
      vision: false,
      tools: false,
    });
    expect(displayReasoningEfforts("river", model)).toEqual(["none", "low", "high"]);
    expect(modelSupportsVision("river", model)).toBe(false);
    expect(resolveToolDialect("river", model)).toBe("none");
    expect(resolveContextWindow({ provider: "river", model }).tokens).toBe(800_000);
  });

  it("does not let model-family inference invent facts for future routes", () => {
    for (const model of ["deepseek-ai/DeepSeek-V5-Unknown", "zai-org/GLM-6-Unknown", "mistral-small-latest"]) {
      expect(modelCatalogFacts("river", model)).toBeUndefined();
      expect(modelSupportsThinking("river", model)).toBe(false);
      const profile = resolveBuiltInProfile({ provider: "river", model });
      expect(profile.reasoning.acceptedEfforts).toEqual([]);
      expect(profile.reasoning.control.status).toBe("unsupported");
    }
  });

  it("learns new routes from metadata without assuming DeepSeek's control vocabulary", () => {
    const model = "new/vision-reasoner";
    registerModelCatalog("river", riverModelCatalog({ data: [{
      id: model,
      supported_reasoning_efforts: ["low", "high"],
      input_modalities: ["text", "image"],
      context_window: 262_144,
      supports_tools: true,
    }] }));
    expect(modelReasoningEfforts("river", model)).toEqual(["low", "high"]);
    expect(routeReasoningIsMandatory("river", model)).toBe(true);
    expect(modelSupportsThinking("river", model)).toBe(true);
    expect(modelSupportsVision("river", model)).toBe(true);
    expect(modelCatalogFacts("river", model)?.maxOutputTokens).toBeUndefined();
  });

  it("honors explicit negative metadata over documented reasoning", () => {
    registerModelCatalog("river", riverModelCatalog({ data: [{ id: RIVER_GLM_MODEL, reasoning: false }] }));
    expect(modelSupportsThinking("river", RIVER_GLM_MODEL)).toBe(false);
    expect(routeReasoningIsMandatory("river", RIVER_GLM_MODEL)).toBe(false);
    expect(modelReasoningEfforts("river", RIVER_GLM_MODEL)).toEqual([]);
    expect(resolveBuiltInProfile({ provider: "river", model: RIVER_GLM_MODEL }).reasoning.control.status).toBe("unsupported");
  });

  it("isolates request metadata from other credentials and falls back only to River docs", () => {
    registerModelCatalog("river", riverModelCatalog({ data: [{
      id: RIVER_DEFAULT_MODEL, context_length: 50_000, supported_reasoning_efforts: ["low"],
    }] }));
    withModelCatalogFacts("river", [], () => {
      expect(modelCatalogFacts("river", RIVER_DEFAULT_MODEL)?.contextTokens).toBe(1_048_576);
      expect(modelReasoningEfforts("river", RIVER_DEFAULT_MODEL)).toEqual(["none", "high", "max"]);
    });
    expect(modelCatalogFacts("river", RIVER_DEFAULT_MODEL)?.contextTokens).toBe(50_000);
  });
});
