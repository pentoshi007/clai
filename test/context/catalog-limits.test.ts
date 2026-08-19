import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  modelContextWindow,
  modelMaxOutputTokens,
  nominalModelContextWindow,
} from "../../src/llm/context-windows.js";
import {
  registerModelCatalogFacts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { parseCatalogFacts } from "../../src/llm/catalog-facts.js";

const UNKNOWN_MODEL = "vendor-x/never-heard-of-it-9000";

beforeEach(() => {
  resetReasoningKnowledge();
});

afterEach(() => {
  resetReasoningKnowledge();
});

describe("catalog-published limits", () => {
  it("reports the catalog number for a model absent from the regex table", () => {
    expect(nominalModelContextWindow(UNKNOWN_MODEL)).toBe(250_000);
    registerModelCatalogFacts(
      "tokenrouter",
      parseCatalogFacts({ id: UNKNOWN_MODEL, context_length: 393_216 })!,
    );
    expect(modelContextWindow(UNKNOWN_MODEL, "tokenrouter")).toBe(393_216);
  });

  it("does not leak one provider's published window to another", () => {
    registerModelCatalogFacts(
      "tokenrouter",
      parseCatalogFacts({ id: UNKNOWN_MODEL, context_length: 393_216 })!,
    );
    expect(modelContextWindow(UNKNOWN_MODEL, "fireworks")).toBe(250_000);
    expect(modelContextWindow(UNKNOWN_MODEL)).toBe(250_000);
  });

  it("keeps a gateway-served override above the published window", () => {
    registerModelCatalogFacts(
      "tokenrouter",
      parseCatalogFacts({ id: "openai/gpt-oss-120b", context_length: 262_144 })!,
    );
    expect(modelContextWindow("openai/gpt-oss-120b", "tokenrouter")).toBe(131_072);
  });

  it("prefers the served context length over the nominal one", () => {
    registerModelCatalogFacts(
      "openrouter",
      parseCatalogFacts({
        id: "~deepseek/deepseek-v4-flash-latest",
        context_length: 1_310_720,
        top_provider: { context_length: 262_144 },
      })!,
    );
    expect(modelContextWindow("~deepseek/deepseek-v4-flash-latest", "openrouter")).toBe(
      262_144,
    );
  });

  it("exposes the published output ceiling and falls back to the profile value", () => {
    registerModelCatalogFacts(
      "openrouter",
      parseCatalogFacts({
        id: "deepseek/deepseek-v4-pro",
        top_provider: { max_completion_tokens: 384_000 },
      })!,
    );
    expect(modelMaxOutputTokens("openrouter", "deepseek/deepseek-v4-pro")).toBe(384_000);
    expect(modelMaxOutputTokens("openrouter", UNKNOWN_MODEL)).toBeUndefined();
    expect(modelMaxOutputTokens("openrouter", UNKNOWN_MODEL, 65_536)).toBe(65_536);
  });
});
