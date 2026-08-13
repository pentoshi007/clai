import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildChatBody,
  isReasoningUnsupportedError,
  ProviderError,
} from "../src/llm/http.js";
import {
  clearReasoningUnsupported,
  isReasoningUnsupported,
  markReasoningUnsupported,
  modelSupportsThinking,
  registerModelReasoningSupport,
  resetReasoningKnowledge,
} from "../src/llm/capabilities.js";
import { providers, streamWithProvider } from "../src/llm/router.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import type { LlmProvider } from "../src/llm/provider.js";
import type { ChatMessage, CompletionRequest } from "../src/types.js";

const userMessages: ChatMessage[] = [{ role: "user", content: "hi" }];

afterEach(() => {
  clearReasoningUnsupported();
  resetReasoningKnowledge();
});

describe("isReasoningUnsupportedError", () => {
  it("detects 4xx bodies that name a reasoning knob", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError(
          "NVIDIA NIM (model=z-ai/glm-5.2): request failed",
          400,
          "chat template does not accept enable_thinking",
        ),
      ),
    ).toBe(true);
    expect(
      isReasoningUnsupportedError(
        new ProviderError("unprocessable", 422, "unknown field reasoning_budget"),
      ),
    ).toBe(true);
  });

  it("detects explicit not-supported wording at any status", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError("reasoning_effort is not supported for this model"),
      ),
    ).toBe(true);
  });

  it("ignores errors that do not mention a reasoning knob", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError("Invalid schema for function 'fs_write'", 400, "tools"),
      ),
    ).toBe(false);
    expect(isReasoningUnsupportedError(new Error("socket closed"))).toBe(false);
  });

  it("does not treat a transient 5xx that merely mentions thinking as a reject", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError("server error while thinking", 500, "thinking"),
      ),
    ).toBe(false);
  });
});

describe("reasoning payload graceful degradation", () => {
  it("modelSupportsThinking returns false after a model is marked unsupported", () => {
    expect(modelSupportsThinking("nvidia", "z-ai/glm-5.2")).toBe(true);
    markReasoningUnsupported("nvidia", "z-ai/glm-5.2");
    expect(isReasoningUnsupported("nvidia", "z-ai/glm-5.2")).toBe(true);
    expect(modelSupportsThinking("nvidia", "z-ai/glm-5.2")).toBe(false);
  });


  it("keeps learned reasoning rejection scoped to one provider route", () => {
    markReasoningUnsupported("nvidia", "deepseek/deepseek-v4-flash-0731");
    expect(modelSupportsThinking("nvidia", "deepseek/deepseek-v4-flash-0731")).toBe(false);
    expect(modelSupportsThinking("tokenrouter", "deepseek/deepseek-v4-flash-0731")).toBe(true);
  });
  it("buildChatBody omits reasoning knobs for a model marked unsupported", () => {
    const before = JSON.parse(
      buildChatBody({
        model: "z-ai/glm-5.2",
        providerId: "nvidia",
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "nvidia",
      }),
    ) as Record<string, unknown>;
    expect(before).toHaveProperty("chat_template_kwargs");

    markReasoningUnsupported("nvidia", "z-ai/glm-5.2");
    const after = JSON.parse(
      buildChatBody({
        model: "z-ai/glm-5.2",
        providerId: "nvidia",
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "nvidia",
      }),
    ) as Record<string, unknown>;
    expect(after).not.toHaveProperty("chat_template_kwargs");
    expect(after).not.toHaveProperty("reasoning_budget");
    expect(after).not.toHaveProperty("reasoning_effort");
  });
});

describe("router retries without reasoning when a knob is rejected", () => {
  const originalNvidia = providers.nvidia;
  const beforeFallback = getConfig().providerFallback;
  const beforeKey = process.env.NVIDIA_API_KEY;

  beforeEach(() => {
    updateConfig({ providerFallback: false });
    process.env.NVIDIA_API_KEY = "nvapi_test_key_for_router";
  });

  afterEach(() => {
    providers.nvidia = originalNvidia;
    updateConfig({ providerFallback: beforeFallback });
    if (beforeKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = beforeKey;
    clearReasoningUnsupported();
  });

  it("marks the model and retries once without reasoning on a 400 knob rejection", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      async stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw new ProviderError(
            "NVIDIA NIM (model=z-ai/glm-5.2): request failed",
            400,
            "chat template does not accept enable_thinking",
          );
        }
        return { text: "ok", provider: "nvidia", model: "z-ai/glm-5.2" };
      },
    } as LlmProvider;

    const tools: NonNullable<CompletionRequest["tools"]> = [
      {
        name: "fs.list",
        wireName: "fs_list",
        description: "List files",
        parameters: { type: "object", properties: {} },
      },
    ];
    const statuses: string[] = [];
    const result = await streamWithProvider(
      {
        provider: "nvidia",
        model: "z-ai/glm-5.2",
        thinking: { enabled: true, effort: "high" },
        messages: userMessages,
        tools,
        toolChoice: "auto",
        parallelToolCalls: true,
      },
      () => undefined,
      (message) => statuses.push(message),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "high" });
    expect(requests[1]!.thinking).toBeUndefined();
    expect(requests[1]!.messages).toEqual(requests[0]!.messages);
    expect(requests[1]!.tools).toEqual(tools);
    expect(requests[1]!.toolChoice).toBe("auto");
    expect(requests[1]!.parallelToolCalls).toBe(true);
    expect(result.text).toBe("ok");
    expect(isReasoningUnsupported("nvidia", "z-ai/glm-5.2")).toBe(true);
    expect(statuses.join("")).toMatch(/rejected reasoning options/i);
  });
});


describe("LLM-005 — Chat Completions reasoning dialect", () => {
  it("sends only reasoning_effort for the openai style", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "gpt-5.1",
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "openai",
      }),
    ) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
    // The nested Responses-API object is what strict gateways 400 on.
    expect(body).not.toHaveProperty("reasoning");
  });

  it("degrades on a bare `reasoning` field rejection", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError(
          "OpenAI (model=gpt-5.1): request failed",
          400,
          "Unrecognized request argument supplied: reasoning",
        ),
      ),
    ).toBe(true);
  });
});


describe("capability table and wire payload agree", () => {
  it("omits reasoning knobs when the capability table says the model has none", () => {
    // Mantle lists only Claude models as reasoning-capable.
    const body = JSON.parse(
      buildChatBody({
        model: "openai.gpt-oss-120b",
        providerId: "aws-mantle",
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "openai",
      }),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("still sends them for a capable model", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "gpt-5.1",
        providerId: "openai",
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "openai",
      }),
    ) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
  });

  it("sends reasoning effort for an unknown custom provider model", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "accounts/fireworks/models/deepseek-v4-flash",
        providerId: "fireworks" as never,
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "openai",
      }),
    ) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
  });

  it("honors an explicit custom-provider catalog denial", () => {
    registerModelReasoningSupport(
      "fireworks" as never,
      "accounts/fireworks/models/basic-chat",
      false,
    );
    const body = JSON.parse(
      buildChatBody({
        model: "accounts/fireworks/models/basic-chat",
        providerId: "fireworks" as never,
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "openai",
      }),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
