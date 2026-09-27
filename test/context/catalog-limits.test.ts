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
    expect(nominalModelContextWindow(UNKNOWN_MODEL)).toBe(200_000);
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
    expect(modelContextWindow(UNKNOWN_MODEL, "fireworks")).toBe(200_000);
    expect(modelContextWindow(UNKNOWN_MODEL)).toBe(200_000);
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

describe("provider catalog limit fields", () => {
  it.each([
    ["Anthropic models API", { id: "claude-x", max_input_tokens: 1_000_000, max_tokens: 128_000 }, 1_000_000, 128_000],
    ["Codex models endpoint", { slug: "gpt-x", id: "gpt-x", context_window: 272_000, max_context_window: 1_000_000 }, 272_000, undefined],
    ["Gemini models API", { id: "gemini-x", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }, 1_048_576, 65_536],
    ["Mistral models API", { id: "mistral-x", max_context_length: 131_072 }, 131_072, undefined],
    ["models.dev style limits", { id: "model-x", limit: { context: 400_000, output: 128_000 } }, 400_000, 128_000],
    ["camel-case gateways", { id: "model-y", contextWindow: 200_000, maxTokens: 64_000 }, 200_000, 64_000],
  ])("reads the %s", (_label, entry, contextTokens, maxOutputTokens) => {
    const facts = parseCatalogFacts(entry)!;
    expect(facts.contextTokens).toBe(contextTokens);
    expect(facts.maxOutputTokens).toBe(maxOutputTokens);
  });

  it("uses Copilot's enforced prompt limit as the served window", () => {
    const facts = parseCatalogFacts({
      id: "copilot-model",
      capabilities: {
        limits: {
          max_context_window_tokens: 200_000,
          max_prompt_tokens: 128_000,
          max_output_tokens: 64_000,
        },
      },
    })!;
    expect(facts).toMatchObject({
      contextTokens: 128_000,
      nominalContextTokens: 200_000,
      maxOutputTokens: 64_000,
    });
  });
});
