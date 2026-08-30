import { afterEach, describe, expect, it, vi } from "vitest";

import { openAiCompatibleComplete, openAiCompatibleStream } from "../../src/llm/http.js";
import { installTransport } from "../conformance/fake-transport.js";

const MODEL = "qwen/qwen3.8-max";
const BASE_URL = "https://api-gateway.merge.dev/v1/openai";

// Shapes captured live from api-gateway.merge.dev on 2026-08-30. Merge
// normalizes every upstream vendor's chain of thought onto `thinking` /
// `thinking_signature` — it never sends `reasoning_content` or `reasoning`.
function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-cc_9e6e4a45b12837d6",
    object: "chat.completion.chunk",
    model: "qwen3.8-max",
    choices: [
      {
        index: 0,
        delta: {
          role: null,
          content: null,
          tool_calls: null,
          annotations: null,
          thinking: null,
          thinking_signature: null,
          ...delta,
        },
        finish_reason: finish ?? null,
      },
    ],
    usage: null,
  })}\n\n`;
}

const FRAMES: readonly string[] = [
  chunk({ role: "assistant" }),
  chunk({ thinking: "17 x 20" }),
  chunk({ thinking: " = 340, plus 51." }),
  chunk({ content: "391" }),
  chunk({}, "stop"),
  "data: [DONE]\n\n",
];

const COMPLETION = {
  id: "chatcmpl-resp_e01ddae4741250e2",
  object: "chat.completion",
  model: "qwen3.8-max",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "391",
        tool_calls: null,
        annotations: null,
        thinking: "17 x 20 = 340, plus 51.",
        thinking_signature: null,
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 22, completion_tokens: 155, total_tokens: 177 },
};

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Merge Gateway reasoning channel", () => {
  it("streams delta.thinking as reasoning, not as dropped output", async () => {
    installTransport(() => sseResponse(FRAMES));
    const reasoning: string[] = [];
    const result = await openAiCompatibleStream({
      provider: "Merge Gateway",
      providerId: "merge-gateway",
      baseUrl: BASE_URL,
      apiKey: "mg_synthetic",
      model: MODEL,
      messages: [{ role: "user", content: "What is 17*23?" }],
      reasoningStyle: "openai",
      reasoning: { enabled: true, effort: "medium" },
      onToken: () => {},
      onStreamEvent: (event) => {
        if (event.type === "reasoning_delta") reasoning.push(event.text);
      },
    });

    expect(reasoning.join("")).toBe("17 x 20 = 340, plus 51.");
    expect(result.reasoningBlock?.text).toBe("17 x 20 = 340, plus 51.");
    expect(result.text).toBe("391");
  });

  it("reads message.thinking on non-streamed completions", async () => {
    installTransport(
      () =>
        new Response(JSON.stringify(COMPLETION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await openAiCompatibleComplete({
      provider: "Merge Gateway",
      providerId: "merge-gateway",
      baseUrl: BASE_URL,
      apiKey: "mg_synthetic",
      model: MODEL,
      messages: [{ role: "user", content: "What is 17*23?" }],
      reasoningStyle: "openai",
      reasoning: { enabled: true, effort: "medium" },
    });

    expect(result.reasoningBlock?.text).toBe("17 x 20 = 340, plus 51.");
    expect(result.text).toBe("391");
  });

  it("ignores a non-string thinking payload", async () => {
    installTransport(() =>
      sseResponse([
        chunk({ thinking: { type: "disabled" } as unknown as string }),
        chunk({ content: "391" }),
        chunk({}, "stop"),
        "data: [DONE]\n\n",
      ]),
    );
    const result = await openAiCompatibleStream({
      provider: "Merge Gateway",
      providerId: "merge-gateway",
      baseUrl: BASE_URL,
      apiKey: "mg_synthetic",
      model: MODEL,
      messages: [{ role: "user", content: "What is 17*23?" }],
      reasoningStyle: "openai",
      onToken: () => {},
    });

    expect(result.reasoningBlock).toBeUndefined();
    expect(result.text).toBe("391");
  });
});
