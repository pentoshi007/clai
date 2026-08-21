import { afterEach, describe, expect, it, vi } from "vitest";

import { openrouterProvider } from "../../src/llm/openrouter.js";
import { visibleReasoningDetailText } from "../../src/llm/reasoning-artifacts.js";
import { installTransport } from "../conformance/fake-transport.js";

const MODEL = "stealth/ox-alpha";

const USAGE_FRAME = {
  prompt_tokens: 10_339,
  completion_tokens: 60,
  total_tokens: 10_399,
  completion_tokens_details: { reasoning_tokens: 0 },
  prompt_tokens_details: { cached_tokens: 10_318, cache_write_tokens: 0 },
};

function frames(deltas: readonly Record<string, unknown>[]): readonly string[] {
  return [
    ...deltas.map(
      (delta) =>
        `data: ${JSON.stringify({
          id: "gen-1",
          object: "chat.completion.chunk",
          model: MODEL,
          choices: [{ index: 0, delta }],
        })}\n\n`,
    ),
    `data: ${JSON.stringify({
      id: "gen-1",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "gen-1",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [],
      usage: USAGE_FRAME,
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function sseResponse(list: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of list) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function streamOpenRouter(deltas: readonly Record<string, unknown>[]) {
  installTransport(() => sseResponse(frames(deltas)));
  return openrouterProvider.stream(
    {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      thinking: { enabled: true, effort: "medium" },
    } as never,
    { apiKey: "synthetic-key" } as never,
    () => {},
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter reasoning telemetry", () => {
  it("records the reported cache read alongside a zero reasoning count", async () => {
    const result = await streamOpenRouter([
      { role: "assistant", reasoning: "thinking hard" },
      { content: "ok" },
    ]);

    expect(result.usage).toMatchObject({
      promptTokens: 10_339,
      cachedPromptTokens: 10_318,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      reasoningObserved: true,
    });
  });

  it("marks reasoning observed when only reasoning_details carry the trace", async () => {
    const result = await streamOpenRouter([
      {
        role: "assistant",
        reasoning_details: [
          {
            type: "reasoning.text",
            text: "structured thinking only",
            id: "r-1",
            format: "anthropic-claude-v1",
            index: 0,
          },
        ],
      },
      { content: "ok" },
    ]);

    expect(result.usage?.reasoningObserved).toBe(true);
    expect(result.usage?.reasoningTokens).toBe(0);
    expect(result.reasoningBlock?.text).toBe("structured thinking only");
  });

  it("does not duplicate the trace when both reasoning shapes arrive", async () => {
    const result = await streamOpenRouter([
      { role: "assistant", reasoning: "plain trace" },
      {
        reasoning_details: [
          { type: "reasoning.text", text: "plain trace", index: 0 },
        ],
      },
      { content: "ok" },
    ]);

    expect(result.reasoningBlock?.text).toBe("plain trace");
  });

  it("never projects encrypted or redacted reasoning as readable text", async () => {
    const result = await streamOpenRouter([
      {
        role: "assistant",
        reasoning_details: [
          { type: "reasoning.encrypted", data: "c2VjcmV0", index: 0 },
          { type: "reasoning.text", text: "[REDACTED]", index: 1 },
        ],
      },
      { content: "ok" },
    ]);

    expect(result.reasoningBlock).toBeUndefined();
    expect(result.usage?.reasoningObserved).toBe(true);
  });
});

describe("visibleReasoningDetailText", () => {
  it("joins readable text and summary entries in order", () => {
    expect(
      visibleReasoningDetailText([
        { type: "reasoning.summary", summary: "summary. " },
        { type: "reasoning.text", text: "detail." },
      ]),
    ).toBe("summary. detail.");
  });

  it("returns undefined for encrypted-only, redacted, or empty payloads", () => {
    expect(
      visibleReasoningDetailText([{ type: "reasoning.encrypted", data: "x" }]),
    ).toBeUndefined();
    expect(
      visibleReasoningDetailText([{ type: "reasoning.text", text: "  " }]),
    ).toBeUndefined();
    expect(visibleReasoningDetailText(undefined)).toBeUndefined();
  });
});
