import { afterEach, describe, expect, it, vi } from "vitest";

import { appendAssistantWithTools } from "../../src/agent/tool-history.js";
import { kiroProvider, resetKiroModelCacheForTesting } from "../../src/llm/kiro.js";
import { createKiroReasoningAccumulator } from "../../src/llm/kiro-reasoning.js";
import { displayReasoningEfforts } from "../../src/llm/capabilities.js";
import type { ProviderStreamEvent } from "../../src/llm/stream-events.js";
import type { ChatMessage } from "../../src/types.js";
import {
  encodeKiroFrame,
  installKiroFetch,
  isKiroCatalogRequest,
  kiroCatalogResponse,
  kiroStreamResponse,
  requestBody,
} from "../helpers/kiro-fixtures.js";

const KEY = "kiro-reasoning-display-key";

function catalog(): Response {
  return kiroCatalogResponse([
    {
      modelId: "gpt-5.6-sol",
      supportedInputTypes: ["TEXT"],
      additionalModelRequestFieldsSchema: {
        type: "object",
        properties: {
          reasoning: {
            type: "object",
            properties: {
              effort: {
                type: "string",
                enum: ["none", "low", "medium", "high", "xhigh", "max"],
              },
            },
          },
        },
        additionalProperties: false,
      },
    },
    {
      modelId: "claude-opus-5.5",
      supportedInputTypes: ["TEXT"],
      additionalModelRequestFieldsSchema: {
        type: "object",
        properties: {
          thinking: {
            type: "object",
            properties: { type: { type: "string", enum: ["adaptive"] } },
          },
          output_config: {
            type: "object",
            properties: {
              effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
            },
          },
        },
      },
    },
  ]);
}

function reasoningDeltas(events: ProviderStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "reasoning_delta" ? [event.text] : []
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetKiroModelCacheForTesting();
});

describe("Kiro reasoning display", () => {
  it("does not display GPT placeholder reasoning and replays the signed opaque block exactly", async () => {
    const bodies: Record<string, unknown>[] = [];
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalog();
      bodies.push(requestBody(init));
      if (bodies.length === 1) {
        return kiroStreamResponse([
          encodeKiroFrame({ ":event-type": "toolUseEvent" }, {
            toolUseId: "call_1",
            name: "lookup",
            input: "{}",
            stop: true,
          }),
          encodeKiroFrame(
            { ":event-type": "reasoningContentEvent" },
            { text: "...", signature: "opaque-signature" },
          ),
        ]);
      }
      return kiroStreamResponse([
        encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "done" }),
      ]);
    });

    const events: ProviderStreamEvent[] = [];
    const first = await kiroProvider.stream!(
      {
        model: "gpt-5.6-sol-thinking",
        messages: [{ role: "user", content: "look it up" }],
        thinking: { enabled: true, effort: "max" },
        onStreamEvent: (event) => events.push(event),
      },
      { apiKey: KEY },
      () => {},
    );

    const firstTurn = (bodies[0]!.conversationState as Record<string, unknown>)
      .currentMessage as Record<string, unknown>;
    expect(firstTurn).toBeDefined();
    expect(bodies[0]!.additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } });
    const deltas = reasoningDeltas(events);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toContain("Reasoning is private on Kiro for gpt-5.6-sol");
    expect(deltas[0]).toContain("at max effort");
    expect(deltas.join("")).not.toMatch(/^\.\.\.$/);
    expect(first.reasoningBlock).toBeUndefined();
    expect(first.reasoningArtifacts).toHaveLength(1);
    expect(first.reasoningArtifacts?.[0]).toMatchObject({
      kind: "signed",
      raw: { text: "...", signature: "opaque-signature" },
    });
    expect(first.reasoningArtifacts?.[0]?.displaySummary).toBeUndefined();

    const history: ChatMessage[] = [{ role: "user", content: "look it up" }];
    appendAssistantWithTools(
      history,
      first.text,
      first.toolCalls ?? [],
      first.reasoningBlock,
      first.reasoningArtifacts,
    );
    history.push({ role: "tool", content: "result", toolCallId: "call_1" } as ChatMessage);
    await kiroProvider.stream!(
      {
        model: "gpt-5.6-sol-thinking",
        messages: history,
        thinking: { enabled: true, effort: "max" },
      },
      { apiKey: KEY },
      () => {},
    );
    const replayHistory = (bodies[1]!.conversationState as Record<string, unknown>)
      .history as Array<Record<string, unknown>>;
    const assistant = replayHistory.find((entry) => entry.assistantResponseMessage)
      ?.assistantResponseMessage as Record<string, unknown>;
    expect(assistant.reasoningContent).toEqual({
      reasoningText: { text: "...", signature: "opaque-signature" },
    });
  });

  it("streams Claude summaries, keeps mid-stream ellipses, and preserves exact signed bytes", async () => {
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalog();
      return kiroStreamResponse([
        encodeKiroFrame({ ":event-type": "reasoningContentEvent" }, { text: "..." }),
        encodeKiroFrame({ ":event-type": "reasoningContentEvent" }, { text: "Listing primes 2,3," }),
        encodeKiroFrame({ ":event-type": "reasoningContentEvent" }, { text: "...\n\n" }),
        encodeKiroFrame({ ":event-type": "reasoningContentEvent" }, { text: "done.\n\n" }),
        encodeKiroFrame({ ":event-type": "reasoningContentEvent" }, { signature: "claude-sig" }),
        encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "17" }),
      ]);
    });

    const events: ProviderStreamEvent[] = [];
    const result = await kiroProvider.stream!(
      {
        model: "claude-opus-5.5-thinking",
        messages: [{ role: "user", content: "count primes" }],
        thinking: { enabled: true, effort: "high" },
        onStreamEvent: (event) => events.push(event),
      },
      { apiKey: KEY },
      () => {},
    );

    expect(reasoningDeltas(events)).toEqual([
      "...Listing primes 2,3,",
      "...\n\n",
      "done.\n\n",
    ]);
    expect(result.reasoningBlock).toEqual({
      text: "...Listing primes 2,3,...\n\ndone.",
      signature: "claude-sig",
    });
    expect(result.reasoningArtifacts?.[0]).toMatchObject({
      kind: "signed",
      raw: { text: "...Listing primes 2,3,...\n\ndone.\n\n", signature: "claude-sig" },
      displaySummary: "...Listing primes 2,3,...\n\ndone.",
    });
  });

  it("recognizes bare reasoningText payloads without an event-type header", async () => {
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalog();
      return kiroStreamResponse([
        encodeKiroFrame({}, {
          reasoningText: { Text: "I should finish the task.", signature: "bare-sig" },
        }),
        encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "done" }),
      ]);
    });

    const result = await kiroProvider.complete(
      {
        model: "claude-opus-5.5-thinking",
        messages: [{ role: "user", content: "finish" }],
        thinking: { enabled: true, effort: "high" },
      },
      { apiKey: KEY },
    );

    expect(result.text).toBe("done");
    expect(result.reasoningBlock).toEqual({
      text: "I should finish the task.",
      signature: "bare-sig",
    });
  });

  it("preserves a signature-only Claude completion instead of throwing an empty-response error", async () => {
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalog();
      return kiroStreamResponse([
        encodeKiroFrame(
          { ":event-type": "reasoningContentEvent" },
          { signature: "signature-only" },
        ),
        encodeKiroFrame({ ":event-type": "messageStopEvent" }, { stopReason: "stop" }),
      ]);
    });

    const result = await kiroProvider.complete(
      {
        model: "claude-opus-5.5-thinking",
        messages: [{ role: "user", content: "finish" }],
        thinking: { enabled: true, effort: "high" },
      },
      { apiKey: KEY },
    );

    expect(result.text).toBe("");
    expect(result.reasoningArtifacts?.[0]).toMatchObject({
      kind: "signed",
      raw: { text: "", signature: "signature-only" },
    });
  });

  it("publishes live Kiro catalog efforts for every model variant", async () => {
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalog();
      return kiroStreamResponse([]);
    });
    await kiroProvider.listModels!({ apiKey: KEY });
    expect(displayReasoningEfforts("kiro", "gpt-5.6-sol-thinking-agentic")).toEqual([
      "none", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(displayReasoningEfforts("kiro", "claude-opus-5.5-thinking")).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });

  it("reads snake_case prompt-cache usage metrics", async () => {
    installKiroFetch(async (input, init) => {
      if (isKiroCatalogRequest(input, init)) return catalog();
      return kiroStreamResponse([
        encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "ok" }),
        encodeKiroFrame({ ":event-type": "metadataEvent" }, {
          usage: {
            input_tokens: 2_000,
            output_tokens: 5,
            cache_read_input_tokens: 1_500,
            cache_creation_input_tokens: 400,
          },
        }),
      ]);
    });
    const result = await kiroProvider.complete(
      { model: "claude-opus-5.5", messages: [{ role: "user", content: "hi" }] },
      { apiKey: KEY },
    );
    expect(result.usage).toMatchObject({
      cachedPromptTokens: 1_500,
      cacheCreationTokens: 400,
    });
  });

  it("flushes unsigned placeholder-only reasoning at the end of the stream", () => {
    const emitted: string[] = [];
    const reasoning = createKiroReasoningAccumulator((text) => emitted.push(text));
    reasoning.push("...");
    expect(emitted).toEqual([]);
    reasoning.finish();
    expect(emitted).toEqual(["..."]);
    expect(reasoning.opaque).toBe(false);
  });

  it("treats signed placeholder-only reasoning as opaque", () => {
    const emitted: string[] = [];
    const reasoning = createKiroReasoningAccumulator((text) => emitted.push(text));
    reasoning.push("\u2026");
    reasoning.sign("sig");
    reasoning.finish();
    expect(emitted).toEqual([]);
    expect(reasoning.opaque).toBe(true);
  });
});
