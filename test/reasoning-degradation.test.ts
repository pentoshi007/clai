import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChatBody,
  isReasoningUnsupportedError,
  openAiCompatibleComplete,
  ProviderError,
} from "../src/llm/http.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "../src/llm/reasoning-artifacts.js";
import { installTransport } from "./conformance/fake-transport.js";
import { jsonResponse } from "./conformance/wire-fixtures.js";
import {
  clearReasoningUnsupported,
  isReasoningUnsupported,
  markReasoningUnsupported,
  modelSupportsThinking,
  registerModelReasoningSupport,
  resetReasoningKnowledge,
} from "../src/llm/capabilities.js";
import {
  completeWithProvider,
  providers,
  streamWithProvider,
} from "../src/llm/router.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import type { LlmProvider } from "../src/llm/provider.js";
import type { ChatMessage, CompletionRequest } from "../src/types.js";

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => ({
      keys: [{ id: "env", value: `sk-${provider}-testkey`, createdAt: 0 }],
      activeIndex: 0,
      source: "env" as const,
    }),
  };
});

const userMessages: ChatMessage[] = [{ role: "user", content: "hi" }];

afterEach(() => {
  clearReasoningUnsupported();
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
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

  it("walks the effort ladder and keeps reasoning at a lower effort on a 400 knob rejection", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      reasoningStyle: "meta",
      async stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw new ProviderError(
            "Meta (model=muse-spark-1.2): request failed",
            400,
            "reasoning_effort value not supported",
          );
        }
        return { text: "ok", provider: "nvidia", model: "muse-spark-1.2" };
      },
    } as LlmProvider;

    const statuses: string[] = [];
    const result = await streamWithProvider(
      {
        provider: "nvidia",
        model: "muse-spark-1.2",
        thinking: { enabled: true, effort: "max" },
        messages: userMessages,
      },
      () => undefined,
      (message) => statuses.push(message),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(requests[1]!.thinking).toEqual({ enabled: true, effort: "high" });
    expect(result.text).toBe("ok");
    expect(isReasoningUnsupported("nvidia", "muse-spark-1.2")).toBe(false);
    expect(statuses.join("")).toMatch(/rejected reasoning effort/i);
  });

  it("strips reasoning entirely after every ladder effort is rejected", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      reasoningStyle: "meta",
      async stream(request) {
        requests.push(request);
        if (request.thinking?.enabled) {
          throw new ProviderError(
            "Meta (model=muse-spark-1.2): request failed",
            400,
            "reasoning_effort value not supported",
          );
        }
        return { text: "ok", provider: "nvidia", model: "muse-spark-1.2" };
      },
    } as LlmProvider;

    const statuses: string[] = [];
    const result = await streamWithProvider(
      {
        provider: "nvidia",
        model: "muse-spark-1.2",
        thinking: { enabled: true, effort: "max" },
        messages: userMessages,
      },
      () => undefined,
      (message) => statuses.push(message),
    );

    expect(requests).toHaveLength(3);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(requests[1]!.thinking).toEqual({ enabled: true, effort: "high" });
    expect(requests[2]!.thinking).toBeUndefined();
    expect(result.text).toBe("ok");
    expect(isReasoningUnsupported("nvidia", "muse-spark-1.2")).toBe(true);
    expect(statuses.join("")).toMatch(/rejected reasoning options/i);
  });

  it("stops the ladder when a rung hits a non-reasoning 503 server error", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      reasoningStyle: "meta",
      async stream(request) {
        requests.push(request);
        const effort = request.thinking?.effort;
        if (effort === "max") {
          throw new ProviderError(
            "Meta (model=muse-spark-1.2): request failed",
            400,
            "reasoning_effort value not supported",
          );
        }
        if (effort === "high") {
          throw new ProviderError("upstream 503", 503);
        }
        return { text: "ok", provider: "nvidia", model: "muse-spark-1.2" };
      },
    } as LlmProvider;

    await expect(
      streamWithProvider(
        {
          provider: "nvidia",
          model: "muse-spark-1.2",
          thinking: { enabled: true, effort: "max" },
          messages: userMessages,
        },
        () => undefined,
        { maxRetries: 0 },
      ),
    ).rejects.toThrow(/No provider could stream the request/);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(requests[1]!.thinking).toEqual({ enabled: true, effort: "high" });
    expect(isReasoningUnsupported("nvidia", "muse-spark-1.2")).toBe(false);
  });

  it("does not enter the ladder on a bare 5xx server error", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      async stream(request) {
        requests.push(request);
        if (request.thinking?.enabled) {
          throw new ProviderError("upstream 503", 503);
        }
        return { text: "ok", provider: "nvidia", model: "z-ai/glm-5.2" };
      },
    } as LlmProvider;

    await expect(
      streamWithProvider(
        {
          provider: "nvidia",
          model: "z-ai/glm-5.2",
          thinking: { enabled: true, effort: "max" },
          messages: userMessages,
        },
        () => undefined,
        { maxRetries: 0 },
      ),
    ).rejects.toThrow(/No provider could stream the request/);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(isReasoningUnsupported("nvidia", "z-ai/glm-5.2")).toBe(false);
  });

  it("does not enter the ladder on a bare 500 on the non-streaming path", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      async complete(request) {
        requests.push(request);
        if (request.thinking?.enabled) {
          throw new ProviderError("upstream 500", 500);
        }
        return { text: "ok", provider: "nvidia", model: "z-ai/glm-5.2" };
      },
    } as LlmProvider;

    await expect(
      completeWithProvider(
        {
          provider: "nvidia",
          model: "z-ai/glm-5.2",
          thinking: { enabled: true, effort: "max" },
          messages: userMessages,
        },
        { maxRetries: 0 },
      ),
    ).rejects.toThrow(/No provider could complete the request/);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(isReasoningUnsupported("nvidia", "z-ai/glm-5.2")).toBe(false);
  });

  it("does not enter the ladder on a non-reasoning 500 body", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      async stream(request) {
        requests.push(request);
        if (request.thinking?.enabled) {
          throw new ProviderError(
            "NVIDIA NIM (model=z-ai/glm-5.2): request failed",
            500,
            "sensitive words detected",
          );
        }
        return { text: "ok", provider: "nvidia", model: "z-ai/glm-5.2" };
      },
    } as LlmProvider;

    await expect(
      streamWithProvider(
        {
          provider: "nvidia",
          model: "z-ai/glm-5.2",
          thinking: { enabled: true, effort: "max" },
          messages: userMessages,
        },
        () => undefined,
        { maxRetries: 0 },
      ),
    ).rejects.toThrow(/No provider could stream the request/);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(isReasoningUnsupported("nvidia", "z-ai/glm-5.2")).toBe(false);
  });

  it("enters the ladder on a reasoning-related 5xx body and strips reasoning", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      reasoningStyle: "meta",
      async stream(request) {
        requests.push(request);
        if (request.thinking?.enabled) {
          throw new ProviderError(
            "NVIDIA NIM (model=muse-spark-1.2): request failed",
            500,
            "reasoning_effort failed",
          );
        }
        return { text: "ok", provider: "nvidia", model: "muse-spark-1.2" };
      },
    } as LlmProvider;

    const result = await streamWithProvider(
      {
        provider: "nvidia",
        model: "muse-spark-1.2",
        thinking: { enabled: true, effort: "max" },
        messages: userMessages,
      },
      () => undefined,
      { maxRetries: 0 },
    );

    expect(requests).toHaveLength(3);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(requests[1]!.thinking).toEqual({ enabled: true, effort: "high" });
    expect(requests[2]!.thinking).toBeUndefined();
    expect(result.text).toBe("ok");
    expect(isReasoningUnsupported("nvidia", "muse-spark-1.2")).toBe(true);
  });

  it("walks the effort ladder on the non-streaming path too", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      reasoningStyle: "meta",
      async complete(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw new ProviderError(
            "Meta (model=muse-spark-1.2): request failed",
            400,
            "reasoning_effort value not supported",
          );
        }
        return { text: "ok", provider: "nvidia", model: "muse-spark-1.2" };
      },
    } as LlmProvider;

    const result = await completeWithProvider({
      provider: "nvidia",
      model: "muse-spark-1.2",
      thinking: { enabled: true, effort: "max" },
      messages: userMessages,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(requests[1]!.thinking).toEqual({ enabled: true, effort: "high" });
    expect(result.text).toBe("ok");
    expect(isReasoningUnsupported("nvidia", "muse-spark-1.2")).toBe(false);
  });

  it("does not retry identical wire values for openai-style providers", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      reasoningStyle: "openai",
      async stream(request) {
        requests.push(request);
        if (request.thinking?.enabled) {
          throw new ProviderError(
            "TokenRouter (model=gpt-5.1): request failed",
            400,
            "reasoning_effort value not supported",
          );
        }
        return { text: "ok", provider: "nvidia", model: "gpt-5.1" };
      },
    } as LlmProvider;

    const result = await streamWithProvider(
      {
        provider: "nvidia",
        model: "gpt-5.1",
        thinking: { enabled: true, effort: "max" },
        messages: userMessages,
      },
      () => undefined,
      () => undefined,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]!.thinking).toEqual({ enabled: true, effort: "max" });
    expect(requests[1]!.thinking).toBeUndefined();
    expect(result.text).toBe("ok");
    expect(isReasoningUnsupported("nvidia", "gpt-5.1")).toBe(true);
  });

  it("emits status messages on the non-streaming path", async () => {
    const requests: CompletionRequest[] = [];
    providers.nvidia = {
      ...originalNvidia,
      reasoningStyle: "meta",
      async complete(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw new ProviderError(
            "Meta (model=muse-spark-1.2): request failed",
            400,
            "reasoning_effort value not supported",
          );
        }
        return { text: "ok", provider: "nvidia", model: "muse-spark-1.2" };
      },
    } as LlmProvider;

    const statuses: string[] = [];
    const result = await completeWithProvider(
      {
        provider: "nvidia",
        model: "muse-spark-1.2",
        thinking: { enabled: true, effort: "max" },
        messages: userMessages,
      },
      { onStatus: (message) => statuses.push(message) },
    );

    expect(requests).toHaveLength(2);
    expect(result.text).toBe("ok");
    expect(statuses.join("")).toMatch(/rejected reasoning effort/i);
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



describe("reasoning content replay survives the effort strip", () => {
  it("replays reasoning_content on prior assistant messages after the knob is stripped", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think about it" },
      {
        role: "assistant",
        content: "here is the answer",
        reasoningBlock: { text: "hidden chain of thought" },
      },
    ];

    markReasoningUnsupported("tokenrouter", "qwen3-coder");

    const body = JSON.parse(
      buildChatBody({
        model: "qwen3-coder",
        providerId: "tokenrouter",
        messages,
        stream: false,
        reasoning: { enabled: true, effort: "max" },
        reasoningStyle: "openai",
        replayTarget: {
          provider: "tokenrouter",
          model: "qwen3-coder",
          dialect: "openai-compatible",
        },
      }),
    ) as Record<string, unknown>;

    expect(body).not.toHaveProperty("reasoning_effort");
    const wireMessages = body.messages as Array<Record<string, unknown>>;
    const assistant = wireMessages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant).toHaveProperty(
      "reasoning_content",
      "hidden chain of thought",
    );
  });

  it("sends clamped reasoning_effort and perf_metrics for Fireworks", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "accounts/fireworks/models/deepseek-v4-flash",
        providerId: "fireworks",
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "max" },
        reasoningStyle: "openai",
      }),
    ) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
    expect(body.perf_metrics_in_response).toBe(true);
  });
});
describe("TokenRouter reasoning replay after knob rejection", () => {
  it("replays reasoning_content while stripping reasoning_effort after rejection", async () => {
    const artifact = createReasoningArtifact({
      kind: "plaintext",
      raw: "hidden chain of thought",
      provenance: createReasoningArtifactProvenance({
        provider: "tokenrouter",
        model: "qwen3-coder",
        dialect: "openai-compatible",
        endpoint: "https://api.tokenrouter.com/v1",
      }),
      replay: { scope: "all-history", persistence: "tool-turn" },
      position: { sequence: 0, placement: "before-tool-call", toolCallIndex: 0 },
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "think about it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "fs.read", args: { path: "a.ts" } }],
        reasoningArtifacts: [artifact],
      },
      { role: "tool", toolCallId: "call_1", name: "fs.read", content: "ok" },
    ];

    markReasoningUnsupported("tokenrouter", "qwen3-coder");

    const transport = installTransport(() =>
      jsonResponse({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      }),
    );

    await openAiCompatibleComplete({
      provider: "TokenRouter",
      providerId: "tokenrouter",
      baseUrl: "https://api.tokenrouter.com/v1",
      apiKey: "synthetic-key",
      model: "qwen3-coder",
      messages,
      reasoning: { enabled: true, effort: "max" },
      reasoningStyle: "openai",
    });

    const body = transport.generations[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("reasoning_effort");
    const wireMessages = body.messages as Array<Record<string, unknown>>;
    const assistant = wireMessages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant).toHaveProperty(
      "reasoning_content",
      "hidden chain of thought",
    );
  });
});
