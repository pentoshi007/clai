import { describe, expect, it } from "vitest";

import { COMPACTION_MAP_MAX_COMPLETION_TOKENS } from "../../src/agent/compaction-summary.js";
import { chatCompletionsBodyFromPlan } from "../../src/llm/http.js";
import { compileRequestPlan } from "../../src/llm/request-plan.js";
import {
  clearModelCatalogFacts,
  registerModelCatalogFacts,
} from "../../src/llm/capabilities.js";
import type { ProviderId } from "../../src/llm/provider-ids.js";
import { afterEach } from "vitest";

function budgetFor(
  provider: ProviderId,
  model: string,
  options: { reasoning?: boolean; maxTokens?: number; tools?: boolean } = {},
): { maxTokens?: number; maxCompletionTokens?: number } {
  const plan = compileRequestPlan({
    provider,
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    ...(options.reasoning
      ? { reasoning: { enabled: true, effort: "high" as const } }
      : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.tools
      ? {
          tools: [
            {
              name: "fs.read",
              description: "read a file",
              parameters: { type: "object", properties: {} },
            },
          ],
        }
      : {}),
  });
  const body = JSON.parse(chatCompletionsBodyFromPlan(plan)) as Record<
    string,
    unknown
  >;
  return {
    ...(typeof body["max_tokens"] === "number"
      ? { maxTokens: body["max_tokens"] }
      : {}),
    ...(typeof body["max_completion_tokens"] === "number"
      ? { maxCompletionTokens: body["max_completion_tokens"] }
      : {}),
  };
}

afterEach(() => {
  clearModelCatalogFacts();
});

describe("output budget clears the reasoning floor", () => {
  it("a Kimi thinking route with tools gets at least 16000", () => {
    const budget = budgetFor("tokenrouter", "moonshotai/kimi-k3", {
      reasoning: true,
      maxTokens: 1_024,
      tools: true,
    });
    expect(budget.maxTokens).toBeGreaterThanOrEqual(16_000);
  });

  it("uses the family floor rather than the generic one where declared", () => {
    expect(
      budgetFor("bynara", "kimi-k2.6", { reasoning: true, maxTokens: 512 })
        .maxTokens,
    ).toBe(16_000);
  });

  it("applies the generic floor to a reasoning route with no declared minimum", () => {
    expect(
      budgetFor("qwen-cloud", "qwen3.7-plus", { reasoning: true, maxTokens: 512 })
        .maxTokens,
    ).toBe(16_384);
  });

  it("leaves a non-reasoning turn's budget alone", () => {
    expect(
      budgetFor("nvidia", "meta/llama-3.3-70b-instruct", { maxTokens: 1_024 }).maxTokens,
    ).toBe(1_024);
  });

  it("never exceeds a published output ceiling", () => {
    registerModelCatalogFacts("tokenrouter", {
      id: "moonshotai/kimi-k3",
      maxOutputTokens: 8_000,
    });
    const budget = budgetFor("tokenrouter", "moonshotai/kimi-k3", {
      reasoning: true,
      maxTokens: 1_024,
    });
    expect(budget.maxTokens).toBe(8_000);
  });

  it("keeps a caller budget above the floor", () => {
    expect(
      budgetFor("tokenrouter", "moonshotai/kimi-k3", {
        reasoning: true,
        maxTokens: 40_000,
      }).maxTokens,
    ).toBe(40_000);
  });

  it("floors the openai reasoning field too", () => {
    expect(
      budgetFor("openai", "gpt-5.4-mini", { reasoning: true, maxTokens: 512 })
        .maxCompletionTokens,
    ).toBe(16_384);
  });

  it("the compaction map stage no longer budgets below the reasoning floor", () => {
    expect(COMPACTION_MAP_MAX_COMPLETION_TOKENS).toBeGreaterThanOrEqual(16_000);
  });
});
