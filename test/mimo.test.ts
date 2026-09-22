import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoProvider } from "../src/llm/mimo.js";
import { getProvider } from "../src/llm/routing/provider-selection.js";
import { resolveBuiltInProfile } from "../src/llm/provider-profiles.js";
import { modelSupportsThinking } from "../src/llm/capabilities.js";
import { modelAcceptsImages } from "../src/llm/capabilities.js";
import { modelContextWindow } from "../src/llm/context-windows.js";
import { normalizeProvider } from "../src/llm/provider.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "../src/llm/reasoning-artifacts.js";

const catalogPayload = {
  object: "list",
  data: [
    { id: "mimo-v2.6-pro", object: "model" },
    { id: "mimo-v2.6-flash", object: "model" },
    { id: "mimo-v2.5-pro", object: "model" },
    { id: "mimo-v2.5", object: "model" },
  ],
};

function catalogResponse() {
  return new Response(JSON.stringify(catalogPayload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function completionResponse(body: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "mimo-v2.6-pro",
      usage: {
        prompt_tokens: 249,
        completion_tokens: 32,
        total_tokens: 281,
        prompt_tokens_details: { cached_tokens: 192 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
      ...body,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("MiMo provider registration", () => {
  it("resolves aliases to the mimo provider id", () => {
    expect(normalizeProvider("mimo")).toBe("mimo");
    expect(normalizeProvider("xiaomi")).toBe("mimo");
    expect(normalizeProvider("xiaomi-mimo")).toBe("mimo");
    expect(normalizeProvider("MiMo")).toBe("mimo");
  });

  it("is registered in the provider registry with a default model", () => {
    const provider = getProvider("mimo");
    expect(provider.id).toBe("mimo");
    expect(provider.displayName).toBe("Xiaomi MiMo");
    expect(provider.defaultModel).toBe("mimo-v2.6-pro");
    expect(provider.envVar).toBe("MIMO_API_KEY");
  });

  it("accepts sk- and tp- key formats", () => {
    expect(mimoProvider.validateKey("sk-abc123def456")).toBe(true);
    expect(mimoProvider.validateKey("tp-abc123def456")).toBe(true);
    expect(mimoProvider.validateKey("not-a-key")).toBe(false);
  });
});

describe("MiMo listModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches /models with bearer auth and ingests the catalog", async () => {
    const fetchMock = vi.fn(async () => catalogResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await mimoProvider.listModels!({ apiKey: "sk-test-key-123456" });

    expect(result).toEqual([
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
    ]);
    const call = fetchMock.mock.calls.at(-1)!;
    expect(String(call[0])).toBe("https://api.xiaomimimo.com/v1/models");
    expect((call[1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer sk-test-key-123456",
    });
  });

  it("requires an API key", async () => {
    await expect(mimoProvider.listModels!({})).rejects.toThrow(
      /API key is required/,
    );
  });
});

describe("MiMo chat completions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends thinking.enabled by default and parses reasoning + cached tokens", async () => {
    const fetchMock = vi.fn(async () =>
      completionResponse({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "the answer",
              reasoning_content: "thinking out loud",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await mimoProvider.complete(
      {
        model: "mimo-v2.6-pro",
        messages: [{ role: "user", content: "hello" }],
        thinking: { enabled: true, effort: "medium" },
      },
      { apiKey: "sk-test-key-123456" },
    );

    const call = fetchMock.mock.calls.at(-1)!;
    expect(String(call[0])).toBe(
      "https://api.xiaomimimo.com/v1/chat/completions",
    );
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.model).toBe("mimo-v2.6-pro");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(result.text).toBe("the answer");
    expect(result.usage?.cachedPromptTokens).toBe(192);
    expect(result.usage?.reasoningTokens).toBe(12);
  });

  it("sends thinking.disabled when reasoning is off", async () => {
    const fetchMock = vi.fn(async () =>
      completionResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "plain answer" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await mimoProvider.complete(
      {
        model: "mimo-v2.6-flash",
        messages: [{ role: "user", content: "hello" }],
        thinking: { enabled: false, effort: "none" },
      },
      { apiKey: "sk-test-key-123456" },
    );

    const body = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string,
    );
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("echoes prior reasoning_content back on multi-turn requests", async () => {
    const fetchMock = vi.fn(async () =>
      completionResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "next answer" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await mimoProvider.complete(
      {
        model: "mimo-v2.6-pro",
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: "first answer",
            reasoningArtifacts: [
              createReasoningArtifact({
                kind: "plaintext",
                raw: "earlier chain of thought",
                displaySummary: "earlier chain of thought",
                provenance: createReasoningArtifactProvenance({
                  provider: "mimo",
                  model: "mimo-v2.6-pro",
                  dialect: "openai-compatible",
                  endpoint: "https://api.xiaomimimo.com/v1",
                }),
                replay: { scope: "all-history", persistence: "all-turns" },
                position: { sequence: 0, placement: "assistant" },
              }),
            ],
          } as never,
          { role: "user", content: "second" },
        ],
        thinking: { enabled: true, effort: "medium" },
      },
      { apiKey: "sk-test-key-123456" },
    );

    const body = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string,
    );
    const assistant = body.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant.reasoning_content).toBe("earlier chain of thought");
  });
});

describe("MiMo capability resolution", () => {
  it("resolves the deep-thinking profile for chat models", () => {
    const profile = resolveBuiltInProfile({
      provider: "mimo",
      model: "mimo-v2.6-pro",
    });
    expect(profile.reasoning.control.dialect).toBe("deepseek-thinking");
    expect(profile.reasoning.control.status).toBe("supported");
    expect(profile.reasoning.generation).toBe("default-on");
    expect(profile.reasoning.acceptedEfforts).toEqual([]);
    expect(profile.reasoning.disable).toBe("supported");
    expect(profile.reasoning.replayScope).toBe("all-history");
    expect(profile.reasoning.finalTurnPreservation).toBe("required");
    expect(profile.cache.kind).toBe("automatic-prefix");
    expect(profile.usage.cachedInput).toContain(
      "usage.prompt_tokens_details.cached_tokens",
    );
    expect(profile.capabilities.tools).toBe("supported");
    expect(profile.capabilities.images).toBe("supported");
    expect(profile.limits.outputTokens).toBe(131_072);
  });

  it("marks asr/tts models as non-reasoning and text-only", () => {
    const profile = resolveBuiltInProfile({
      provider: "mimo",
      model: "mimo-v2.5-asr",
    });
    expect(profile.reasoning.generation).toBe("none");
    expect(profile.reasoning.control.status).toBe("unsupported");
    expect(profile.capabilities.images).toBe("unsupported");
  });

  it("detects thinking support and vision per model family", () => {
    expect(modelSupportsThinking("mimo", "mimo-v2.6-pro")).toBe(true);
    expect(modelSupportsThinking("mimo", "mimo-v2.5")).toBe(true);
    expect(modelAcceptsImages("mimo", "mimo-v2.5")).toBe(true);
    expect(modelAcceptsImages("mimo", "mimo-v2.6-flash")).toBe(true);
    expect(modelAcceptsImages("mimo", "mimo-v2.5-asr")).toBe(false);
  });

  it("assigns 1M context to v2.5/v2.6 chat models", () => {
    expect(modelContextWindow("mimo-v2.6-pro", "mimo")).toBe(1_000_000);
    expect(modelContextWindow("mimo-v2.5", "mimo")).toBe(1_000_000);
    expect(modelContextWindow("mimo-v2.5-asr", "mimo")).toBe(32_768);
  });
});
