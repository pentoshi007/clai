import { afterEach, describe, expect, it, vi } from "vitest";

import { openAiCompatibleStream } from "../../src/llm/http.js";
import { installTransport } from "../conformance/fake-transport.js";

const MODEL = "accounts/fireworks/models/kimi-k2p6";

const CAPTURED_KIMI_TAIL: readonly string[] = [
  `data: ${JSON.stringify({
    id: "chatcmpl-2686c8354d7d4ea8b821841d6924feb8",
    object: "chat.completion.chunk",
    created: 1787126093,
    model: MODEL,
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
    usage: null,
  })}\n\n`,
  `data: ${JSON.stringify({
    id: "chatcmpl-2686c8354d7d4ea8b821841d6924feb8",
    object: "chat.completion.chunk",
    created: 1787126093,
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "stop", raw_output: null }],
    usage: null,
  })}\n\n`,
  `data: ${JSON.stringify({
    id: "chatcmpl-2686c8354d7d4ea8b821841d6924feb8",
    object: "chat.completion.chunk",
    created: 1787126093,
    model: MODEL,
    choices: [],
    usage: {
      prompt_tokens: 15,
      total_tokens: 54,
      completion_tokens: 39,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  })}\n\n`,
  "data: [DONE]\n\n",
];

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function streamCaptured(frames: readonly string[]) {
  installTransport(() => sseResponse(frames));
  return openAiCompatibleStream({
    provider: "Fireworks",
    providerId: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKey: "synthetic-key",
    model: MODEL,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    reasoningStyle: "openai",
    onToken: () => {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Kimi streams report usage at the chunk root", () => {
  it("reads the usage-only final chunk captured from a live Kimi stream", async () => {
    const result = await streamCaptured(CAPTURED_KIMI_TAIL);
    expect(result.usage).toMatchObject({
      promptTokens: 15,
      completionTokens: 39,
      totalTokens: 54,
    });
  });

  it("does not let an intermediate usage:null chunk erase the real usage", async () => {
    const result = await streamCaptured(CAPTURED_KIMI_TAIL);
    expect(result.usage?.totalTokens).toBe(54);
  });

  it("still delivers the visible answer alongside the trailing usage chunk", async () => {
    const result = await streamCaptured(CAPTURED_KIMI_TAIL);
    expect(result.text).toContain("ok");
  });
});
