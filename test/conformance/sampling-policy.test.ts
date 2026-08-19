import { describe, expect, it } from "vitest";

import { compileRequestPlan } from "../../src/llm/request-plan.js";
import { chatCompletionsBodyFromPlan } from "../../src/llm/http.js";
import type { ProviderId } from "../../src/llm/provider-ids.js";

function bodyFor(
  provider: ProviderId,
  model: string,
  options: {
    reasoning?: { enabled: boolean; effort: "low" | "medium" | "high" };
    temperature?: number;
  } = {},
): Record<string, unknown> {
  const plan = compileRequestPlan({
    provider,
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
  });
  return JSON.parse(chatCompletionsBodyFromPlan(plan)) as Record<string, unknown>;
}

describe("sampling follows the declared capability, not a model-id regex", () => {
  const OMIT_TEMPERATURE: ReadonlyArray<readonly [ProviderId, string]> = [
    ["tokenrouter", "moonshotai/kimi-k3"],
    ["bynara", "kimi-k2.6"],
    ["fireworks", "accounts/fireworks/models/kimi-k2p6"],
    ["modal", "moonshotai/Kimi-K3"],
    ["tokenrouter", "deepseek/deepseek-v4-pro"],
    ["openai", "gpt-5.4-mini"],
  ];

  for (const [provider, model] of OMIT_TEMPERATURE) {
    it(`${provider} ${model} omits temperature`, () => {
      const body = bodyFor(provider, model, {
        reasoning: { enabled: true, effort: "high" },
      });
      expect(body).not.toHaveProperty("temperature");
    });
  }

  const KEEP_TEMPERATURE: ReadonlyArray<readonly [ProviderId, string]> = [
    ["nvidia", "meta/llama-3.3-70b-instruct"],
    ["nvidia", "meta/llama-3.3-70b-instruct"],
    ["qwen-cloud", "qwen3.7-plus"],
  ];

  for (const [provider, model] of KEEP_TEMPERATURE) {
    it(`${provider} ${model} still sends temperature`, () => {
      const body = bodyFor(provider, model);
      expect(typeof body["temperature"]).toBe("number");
    });
  }

  it("deepseek v4 omits top_p as well as temperature while thinking", () => {
    const body = bodyFor("tokenrouter", "deepseek/deepseek-v4-pro", {
      reasoning: { enabled: true, effort: "high" },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  it("a caller temperature cannot re-enable a field the route rejects", () => {
    const body = bodyFor("tokenrouter", "moonshotai/kimi-k3", {
      reasoning: { enabled: true, effort: "high" },
      temperature: 0.9,
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("a caller temperature is honored where the route accepts one", () => {
    const body = bodyFor("nvidia", "meta/llama-3.3-70b-instruct", { temperature: 0.9 });
    expect(body["temperature"]).toBe(0.9);
  });

  it("the plan and the wire agree about what is sent", () => {
    const plan = compileRequestPlan({
      provider: "tokenrouter",
      model: "moonshotai/kimi-k3",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      reasoning: { enabled: true, effort: "high" },
    });
    expect(plan.controls.temperature).toBeUndefined();
    expect(plan.policy.sampling.omit).toContain("temperature");
    expect(
      JSON.parse(chatCompletionsBodyFromPlan(plan)),
    ).not.toHaveProperty("temperature");
  });
});
