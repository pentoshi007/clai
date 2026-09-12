import { describe, expect, it } from "vitest";
import { buildReasoningPayload, buildChatBody, ProviderError } from "../src/llm/http.js";
import { bumpMaxTokensForThinkingBudget } from "../src/llm/agentrouter.js";
import { compileRequestPlan } from "../src/llm/request-plan.js";
import type { ChatMessage, ReasoningEffort } from "../src/types.js";

const pref = (enabled: boolean, effort: ReasoningEffort) => ({ enabled, effort });
const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("agentrouter reasoning payloads (model-aware)", () => {
  it("Claude: reasoning_effort when on, nothing when off", () => {
    expect(buildReasoningPayload(pref(true, "high"), "agentrouter", "claude-opus-4-6")).toEqual({
      reasoning_effort: "high",
    });
    expect(buildReasoningPayload(pref(true, "minimal"), "agentrouter", "claude-opus-4-8")).toEqual({
      reasoning_effort: "low", // minimal clamps to low for Claude
    });
    expect(buildReasoningPayload(pref(false, "high"), "agentrouter", "claude-opus-4-7")).toEqual({});
  });

  it("GLM: reasoning_effort when on, thinking.type=disabled when off (the only disable knob)", () => {
    expect(buildReasoningPayload(pref(true, "medium"), "agentrouter", "glm-5.2")).toEqual({
      reasoning_effort: "medium",
    });
    expect(buildReasoningPayload(pref(false, "medium"), "agentrouter", "glm-5.2")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("OpenAI gpt-5.x: preserves minimal; off degrades to minimal; xhigh maps to high", () => {
    expect(buildReasoningPayload(pref(true, "minimal"), "agentrouter", "gpt-5.5")).toEqual({
      reasoning_effort: "minimal",
    });
    expect(buildReasoningPayload(pref(true, "low"), "agentrouter", "gpt-5.5")).toEqual({
      reasoning_effort: "low",
    });
    expect(buildReasoningPayload(pref(true, "xhigh"), "agentrouter", "gpt-5.5")).toEqual({
      reasoning_effort: "high",
    });
    expect(buildReasoningPayload(pref(false, "medium"), "agentrouter", "gpt-5.5")).toEqual({
      reasoning_effort: "minimal",
    });
  });

  it("OpenAI gpt-6: reasoning emits with the same effort mapping as gpt-5", () => {
    expect(buildReasoningPayload(pref(true, "max"), "agentrouter", "gpt-6-astra")).toEqual({
      reasoning_effort: "high",
    });
    expect(buildReasoningPayload(pref(true, "xhigh"), "agentrouter", "gpt-6-astra")).toEqual({
      reasoning_effort: "high",
    });
    expect(buildReasoningPayload(pref(true, "medium"), "agentrouter", "gpt-6-astra")).toEqual({
      reasoning_effort: "medium",
    });
    expect(buildReasoningPayload(pref(false, "medium"), "agentrouter", "gpt-6-astra")).toEqual({
      reasoning_effort: "minimal",
    });
  });

  it("keeps reasoning controls for agentrouter gpt-6 instead of suppressing them", () => {
    const plan = compileRequestPlan({
      provider: "agentrouter",
      model: "gpt-6-astra",
      messages: msgs,
      reasoning: pref(true, "max"),
    });
    expect(plan.controls.controlSuppression).toBeUndefined();
    expect(plan.controls.reasoning).toEqual({ enabled: true, effort: "xhigh" });
  });

  it("does NOT emit the redundant reasoning:{effort} object that no routed model reads", () => {
    for (const model of ["claude-opus-4-6", "glm-5.2", "gpt-5.5"]) {
      const payload = buildReasoningPayload(pref(true, "high"), "agentrouter", model);
      expect(payload).not.toHaveProperty("reasoning");
    }
  });
});

describe("agentrouter buildChatBody", () => {
  it("floors max_tokens to 32000 for Claude when reasoning is enabled", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "claude-opus-4-6",
        messages: msgs,
        stream: false,
        reasoning: pref(true, "high"),
        reasoningStyle: "agentrouter",
      }),
    );
    expect(body.max_tokens).toBe(32000);
    expect(body.reasoning_effort).toBe("high");
  });

  it("keeps a larger caller max_tokens for Claude thinking (floor is a minimum)", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "claude-opus-4-6",
        messages: msgs,
        maxTokens: 50000,
        stream: false,
        reasoning: pref(true, "high"),
        reasoningStyle: "agentrouter",
      }),
    );
    expect(body.max_tokens).toBe(50000);
  });

  it("does not inflate Claude max_tokens when reasoning is off", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "claude-opus-4-6",
        messages: msgs,
        stream: false,
        reasoning: pref(false, "high"),
        reasoningStyle: "agentrouter",
      }),
    );
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("emits thinking.type=disabled for glm when reasoning is off", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "glm-5.2",
        messages: msgs,
        stream: false,
        reasoning: pref(false, "medium"),
        reasoningStyle: "agentrouter",
      }),
    );
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(4096); // not floored — floor is Claude-only
  });

  it("uses max_completion_tokens and omits temperature for gpt-5.5", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "gpt-5.5",
        messages: msgs,
        stream: false,
        reasoning: pref(true, "minimal"),
        reasoningStyle: "agentrouter",
      }),
    );
    expect(body.reasoning_effort).toBe("minimal");
    expect(body).toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("temperature");
  });
});

describe("bumpMaxTokensForThinkingBudget", () => {
  const budgetErr = (max: number, budget: number) =>
    new ProviderError(
      `AgentRouter (model=claude-opus-4-6): Provider request failed with HTTP 400 — max_tokens (${max}) must be greater than thinking.budget_tokens (${budget})`,
      400,
      `{"error":{"message":"max_tokens (${max}) must be greater than thinking.budget_tokens (${budget})"}}`,
    );

  it("bumps above the reported budget so a retry clears it", () => {
    expect(bumpMaxTokensForThinkingBudget(budgetErr(500, 1280), 500)).toBe(32000);
    expect(bumpMaxTokensForThinkingBudget(budgetErr(8192, 40000), 8192)).toBe(48192);
  });

  it("returns undefined when we already send enough headroom", () => {
    expect(bumpMaxTokensForThinkingBudget(budgetErr(50000, 1280), 50000)).toBeUndefined();
  });

  it("returns undefined for unrelated errors (they must propagate)", () => {
    expect(
      bumpMaxTokensForThinkingBudget(new ProviderError("HTTP 429 rate limited", 429), 4096),
    ).toBeUndefined();
    expect(bumpMaxTokensForThinkingBudget(new Error("network down"), 4096)).toBeUndefined();
  });
});
