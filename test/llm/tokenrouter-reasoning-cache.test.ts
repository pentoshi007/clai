import { describe, expect, it } from "vitest";
import { buildChatBody } from "../../src/llm/http.js";
import {
  displayReasoningEfforts,
  effectiveThinkingEffort,
  modelSupportsThinking,
} from "../../src/llm/capabilities.js";
import { compileRequestPlan } from "../../src/llm/request-plan.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { chatCapableCatalog } from "../../src/llm/tokenrouter.js";
import {
  effectivePromptTokens,
  parseOpenAiUsage,
} from "../../src/llm/token-usage.js";
import type { ChatMessage } from "../../src/types.js";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "stable system" },
  { role: "user", content: "route this" },
];

function body(model: string): Record<string, unknown> {
  return JSON.parse(
    buildChatBody({
      providerId: "tokenrouter",
      model,
      messages: MESSAGES,
      stream: true,
      reasoningStyle: "openai",
    }),
  ) as Record<string, unknown>;
}

describe("tokenrouter reasoning efforts", () => {
  it("offers the effort levels of the selected model, not one fixed list", () => {
    expect(displayReasoningEfforts("tokenrouter", "moonshotai/kimi-k3")).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(displayReasoningEfforts("tokenrouter", "openai/gpt-5.4")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(displayReasoningEfforts("tokenrouter", "qwen/qwen3.7-max")).toEqual([
      "low",
      "medium",
      "xhigh",
    ]);
    expect(displayReasoningEfforts("tokenrouter", "MiniMax-M3")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("falls back to the gateway effort set for models without a family contract", () => {
    for (const model of [
      "z-ai/glm-5.3",
      "z-ai/glm-5.3-free",
      "anthropic/claude-opus-4.6",
      "x-ai/grok-4.6",
      "google/gemini-3.5-flash",
    ]) {
      expect(modelSupportsThinking("tokenrouter", model)).toBe(true);
      expect(displayReasoningEfforts("tokenrouter", model)).toEqual([
        "low",
        "medium",
        "high",
      ]);
    }
  });

  it("keeps the resolved profile and the displayed list in agreement", () => {
    for (const model of [
      "moonshotai/kimi-k3",
      "z-ai/glm-5.3",
      "anthropic/claude-opus-4.6",
      "openai/gpt-5.4",
    ]) {
      const profile = resolveBuiltInProfile({ provider: "tokenrouter", model });
      expect(profile.reasoning.control.dialect).toBe("openai-effort");
      expect(profile.reasoning.acceptedEfforts).toEqual(
        displayReasoningEfforts("tokenrouter", model),
      );
    }
  });

  it("clamps a requested effort to what the route accepts", () => {
    expect(
      effectiveThinkingEffort("tokenrouter", "moonshotai/kimi-k3", {
        enabled: true,
        effort: "medium",
      }),
    ).toBe("high");
    expect(
      effectiveThinkingEffort("tokenrouter", "z-ai/glm-5.3", {
        enabled: true,
        effort: "medium",
      }),
    ).toBe("medium");
    expect(
      effectiveThinkingEffort("tokenrouter", "z-ai/glm-5.3", {
        enabled: true,
        effort: "max",
      }),
    ).toBe("high");
    expect(
      compileRequestPlan({
        provider: "tokenrouter",
        model: "moonshotai/kimi-k3",
        messages: MESSAGES,
        stream: true,
        reasoning: { enabled: true, effort: "medium" },
      }).controls.reasoning?.effort,
    ).toBe("high");
  });
});

describe("tokenrouter prompt caching", () => {
  it("declares the probed cache contract", () => {
    const profile = resolveBuiltInProfile({
      provider: "tokenrouter",
      model: "z-ai/glm-5.3",
    });
    expect(profile.cache.kind).toBe("affinity-key");
    expect(profile.cache.affinityField).toBe("prompt_cache_key");
    expect(profile.usage.cachedInput).toEqual([
      "usage.prompt_tokens_details.cached_tokens",
    ]);
  });

  it("sends a stable prompt cache key that survives prefix appends", () => {
    const first = body("z-ai/glm-5.3");
    const appended = JSON.parse(
      buildChatBody({
        providerId: "tokenrouter",
        model: "z-ai/glm-5.3",
        messages: [
          ...MESSAGES,
          { role: "assistant", content: "answer" },
          { role: "user", content: "next" },
        ],
        stream: true,
      }),
    ) as Record<string, unknown>;
    expect(first.prompt_cache_key).toMatch(/^clai-[a-f0-9]{40}$/);
    expect(appended.prompt_cache_key).toBe(first.prompt_cache_key);
  });

  it("reads the gateway cache counters without double counting the prompt", () => {
    const usage = parseOpenAiUsage({
      prompt_tokens: 2881,
      completion_tokens: 3,
      total_tokens: 2884,
      prompt_tokens_details: { audio_tokens: null, cached_tokens: 2880 },
      completion_tokens_details: { reasoning_tokens: 1 },
    })!;
    expect(usage.cachedPromptTokens).toBe(2880);
    expect(usage.reasoningTokens).toBe(1);
    expect(effectivePromptTokens(usage)).toBe(2881);
  });
});

describe("tokenrouter model catalog", () => {
  function ids(entries: Array<Record<string, unknown>>): string[] {
    return chatCapableCatalog({ data: entries }).data.map(
      (entry) => entry.id as string,
    );
  }

  it("keeps chat routes and drops non-chat slugs", () => {
    expect(
      ids([
        { id: "z-ai/glm-5.3-free", supported_endpoint_types: ["openai"] },
        {
          id: "moonshotai/kimi-k3",
          supported_endpoint_types: ["openai", "anthropic"],
        },
        { id: "kling-v3", supported_endpoint_types: ["video-generation"] },
        { id: "openai/gpt-audio", supported_endpoint_types: ["audio-chat"] },
        {
          id: "google/gemini-embedding-2",
          supported_endpoint_types: ["gemini"],
        },
        {
          id: "google/gemini-3-pro-image-preview",
          supported_endpoint_types: ["gemini"],
        },
      ]),
    ).toEqual(["z-ai/glm-5.3-free", "moonshotai/kimi-k3"]);
  });

  it("falls back to tags, then to the raw list, rather than emptying the picker", () => {
    expect(ids([{ id: "legacy-model", tags: "Text,Tools" }])).toEqual([
      "legacy-model",
    ]);
    expect(
      ids([{ id: "kling-v3", supported_endpoint_types: ["video-generation"] }]),
    ).toEqual(["kling-v3"]);
  });
});
