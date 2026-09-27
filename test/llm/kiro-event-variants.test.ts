import { afterEach, describe, expect, it, vi } from "vitest";

import { appendAssistantWithTools } from "../../src/agent/tool-history.js";
import { kiroProvider, resetKiroModelCacheForTesting } from "../../src/llm/kiro.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "../../src/llm/reasoning-artifacts.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import {
  modelContextWindow,
  modelMaxOutputTokens,
} from "../../src/llm/context-windows.js";
import type { ChatMessage, CompletionRequest } from "../../src/types.js";
import {
  encodeKiroFrame,
  installKiroFetch,
  isKiroCatalogRequest,
  kiroCatalogResponse,
  kiroStreamResponse,
  requestBody,
} from "../helpers/kiro-fixtures.js";

const KEY = "kiro-stream-variant-key";
const MODEL = "claude-opus-5";

function catalogResponse(): Response {
  return kiroCatalogResponse([
    {
      modelId: MODEL,
      supportedInputTypes: ["TEXT", "IMAGE"],
      tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
    },
    { modelId: "gpt-6", supportedInputTypes: ["TEXT"] },
  ]);
}

function assistantHistory(body: Record<string, unknown>): Record<string, unknown> {
  const state = body.conversationState as Record<string, unknown>;
  const history = state.history as Array<Record<string, unknown>>;
  const turn = history.find((entry) => entry.assistantResponseMessage);
  expect(turn).toBeDefined();
  return turn?.assistantResponseMessage as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetKiroModelCacheForTesting();
});

describe("Kiro current event variants and recovery", () => {
  it("assembles split tools, captures redacted reasoning, and replays it only to the same model", async () => {
    const generationBodies: Record<string, unknown>[] = [];
    let generation = 0;
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalogResponse();
      generationBodies.push(requestBody(init));
      generation += 1;
      if (generation === 1) {
        return kiroStreamResponse([
          encodeKiroFrame(
            { ":event-type": "reasoningContentEvent" },
            { reasoningContentEvent: { redactedContent: "cmVkYWN0ZWQ=" } },
          ),
          encodeKiroFrame({ ":event-type": "toolUseEvent" }, { name: "lookup" }),
          encodeKiroFrame(
            { ":event-type": "toolUseEvent" },
            { toolUseId: "call_real" },
          ),
          encodeKiroFrame(
            { ":event-type": "toolUseEvent" },
            { input: '{"query":' },
          ),
          encodeKiroFrame(
            { ":event-type": "toolUseEvent" },
            { input: '"docs"}' },
          ),
          encodeKiroFrame({ ":event-type": "toolUseEvent" }, { stop: true }),
          encodeKiroFrame(
            { ":event-type": "metadataEvent" },
            {
              tokenUsage: {
                inputTokens: 120,
                outputTokens: 9,
                cacheReadInputTokens: 80,
                cacheWriteInputTokens: 20,
              },
              stopReason: "tool_use",
            },
          ),
        ]);
      }
      return kiroStreamResponse([
        encodeKiroFrame(
          { ":event-type": "assistantResponseEvent" },
          { content: generation === 2 ? "same model" : "other model" },
        ),
      ]);
    });

    const first = await kiroProvider.complete(
      {
        model: MODEL,
        messages: [{ role: "user", content: "find docs" }],
      },
      { apiKey: KEY },
    );

    expect(first.text).toBe("");
    expect(first.finishReason).toBe("tool_calls");
    expect(first.toolCalls).toEqual([
      {
        id: "call_real",
        name: "lookup",
        args: { query: "docs" },
        rawArguments: '{"query":"docs"}',
      },
    ]);
    expect(first.reasoningBlock).toBeUndefined();
    expect(first.reasoningArtifacts).toHaveLength(1);
    expect(first.reasoningArtifacts?.[0]).toMatchObject({
      kind: "encrypted",
      raw: { redactedContent: "cmVkYWN0ZWQ=" },
      provenance: { provider: "kiro", model: MODEL },
      replay: { scope: "tool-turn", persistence: "tool-turn" },
    });
    expect(first.usage).toMatchObject({
      promptTokens: 120,
      completionTokens: 9,
      totalTokens: 129,
      exact: true,
      cachedPromptTokens: 80,
      cacheCreationTokens: 20,
      uncachedPromptTokens: 40,
    });

    const history: ChatMessage[] = [{ role: "user", content: "find docs" }];
    appendAssistantWithTools(
      history,
      first.text,
      first.toolCalls ?? [],
      first.reasoningBlock,
      first.reasoningArtifacts,
    );
    history.push(
      {
        role: "tool",
        toolCallId: "call_real",
        name: "lookup",
        content: "found",
      },
      { role: "user", content: "summarize" },
    );

    await kiroProvider.complete({ model: MODEL, messages: history }, { apiKey: KEY });
    await kiroProvider.complete(
      { model: "gpt-6", messages: history },
      { apiKey: KEY },
    );

    expect(assistantHistory(generationBodies[1]!).reasoningContent).toEqual({
      redactedContent: "cmVkYWN0ZWQ=",
    });
    expect(assistantHistory(generationBodies[2]!).reasoningContent).toBeUndefined();
  });

  it("serializes current-turn image bytes without changing text content", async () => {
    let generationBody: Record<string, unknown> | undefined;
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalogResponse();
      generationBody = requestBody(init);
      return kiroStreamResponse([
        encodeKiroFrame(
          { ":event-type": "assistantResponseEvent" },
          { content: "seen" },
        ),
      ]);
    });

    const result = await kiroProvider.complete(
      {
        model: MODEL,
        messages: [
          {
            role: "user",
            content: "inspect",
            images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }],
          },
        ],
      },
      { apiKey: KEY },
    );

    expect(result.text).toBe("seen");
    const state = generationBody?.conversationState as Record<string, unknown>;
    const current = state.currentMessage as Record<string, unknown>;
    const message = current.userInputMessage as Record<string, unknown>;
    expect(message.content).toBe("inspect");
    expect(message.images).toEqual([
      { format: "png", source: { bytes: "aW1hZ2U=" } },
    ]);
  });

  it("returns an empty completion to outer recovery without trying regional endpoints", async () => {
    const generationUrls: string[] = [];
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalogResponse();
      generationUrls.push(String(input));
      return kiroStreamResponse([]);
    });

    await expect(
      kiroProvider.complete(
        { model: MODEL, messages: [{ role: "user", content: "answer" }] },
        { apiKey: KEY },
      ),
    ).rejects.toThrow("completed without a visible answer");
    expect(generationUrls).toEqual(["https://runtime.us-east-1.kiro.dev/"]);
  });

  it("retries a semantic signature rejection with replayed reasoning removed", async () => {
    const bodies: Record<string, unknown>[] = [];
    let generation = 0;
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalogResponse();
      bodies.push(requestBody(init));
      generation += 1;
      if (generation === 1) {
        return kiroStreamResponse([
          encodeKiroFrame(
            {
              ":message-type": "exception",
              ":exception-type": "validationException",
            },
            { message: "THINKING_SIGNATURE_MISMATCH: signature invalid" },
          ),
        ]);
      }
      return kiroStreamResponse([
        encodeKiroFrame(
          { ":event-type": "assistantResponseEvent" },
          { content: "recovered" },
        ),
      ]);
    });

    const artifact = createReasoningArtifact({
      kind: "signed",
      raw: { text: "private", signature: "signed-value" },
      displaySummary: "private",
      provenance: createReasoningArtifactProvenance({
        provider: "kiro",
        model: MODEL,
        dialect: "kiro-eventstream",
      }),
      replay: { scope: "tool-turn", persistence: "tool-turn" },
      position: { sequence: 0, placement: "before-tool-call", toolCallIndex: 0 },
    });
    const request: CompletionRequest = {
      model: MODEL,
      messages: [
        { role: "user", content: "look up" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "lookup", args: { q: "x" } }],
          reasoningArtifacts: [artifact],
        },
        { role: "tool", toolCallId: "call_1", content: "result" },
        { role: "user", content: "finish" },
      ],
    };
    const statuses: string[] = [];

    const result = await tryStreamOnce(
      kiroProvider,
      "kiro",
      request,
      MODEL,
      { apiKey: KEY },
      () => {},
      (status) => statuses.push(status),
      "initial",
    );

    expect(result.text).toBe("recovered");
    expect(assistantHistory(bodies[0]!).reasoningContent).toEqual({
      reasoningText: { text: "private", signature: "signed-value" },
    });
    expect(assistantHistory(bodies[1]!).reasoningContent).toBeUndefined();
    expect(statuses.some((status) => status.includes("without it"))).toBe(true);
  });

  it("converts Kiro context percentage against the catalog window the UI reports", async () => {
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) {
        return kiroCatalogResponse([
          {
            modelId: "qwen3-coder-next",
            supportedInputTypes: ["TEXT"],
            tokenLimits: { maxInputTokens: 256_000, maxOutputTokens: 32_000 },
          },
        ]);
      }
      return kiroStreamResponse([
        encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "ok" }),
        encodeKiroFrame({ ":event-type": "metadataEvent" }, { stopReason: "END_TURN" }),
        encodeKiroFrame(
          { ":event-type": "contextUsageEvent" },
          { contextUsagePercentage: 12.5 },
        ),
        encodeKiroFrame(
          { ":event-type": "meteringEvent" },
          { unit: "credit", unitPlural: "credits", usage: 0.02 },
        ),
      ]);
    });

    const result = await kiroProvider.complete(
      { model: "qwen3-coder-next", messages: [{ role: "user", content: "hi" }] },
      { apiKey: KEY },
    );

    expect(result.usage).toMatchObject({
      promptTokens: 32_000,
      totalTokens: 32_000,
      exact: false,
      promptTokensSource: "provider-ratio",
      contextWindowTokens: 256_000,
      charges: [{ amount: 0.02, unit: "credits" }],
    });
    expect(result.usage?.promptTokensKnown).toBeUndefined();
    expect(modelContextWindow("qwen3-coder-next", "kiro")).toBe(256_000);
    expect(modelContextWindow("qwen3-coder-next-thinking", "kiro")).toBe(256_000);
    expect(modelMaxOutputTokens("kiro", "qwen3-coder-next")).toBe(32_000);
  });

  it("keeps percentage usage estimated when the catalog window is unavailable", async () => {
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) {
        return new Response("catalog unavailable", { status: 503 });
      }
      return kiroStreamResponse([
        encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "ok" }),
        encodeKiroFrame(
          { ":event-type": "contextUsageEvent" },
          { contextUsagePercentage: 10 },
        ),
        encodeKiroFrame({ ":event-type": "metadataEvent" }, { stopReason: "END_TURN" }),
      ]);
    });

    const result = await kiroProvider.complete(
      { model: "unknown-model", messages: [{ role: "user", content: "hi" }] },
      { apiKey: KEY },
    );

    expect(result.usage).toMatchObject({
      promptTokens: 20_000,
      totalTokens: 20_000,
      exact: false,
    });
    expect(result.usage?.promptTokensSource).toBeUndefined();
    expect(result.usage?.contextWindowTokens).toBeUndefined();
  });
});
