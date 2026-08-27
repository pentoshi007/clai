import { afterEach, describe, expect, it, vi } from "vitest";
import { metaProvider } from "../src/llm/meta.js";
import type { CompletionRequest } from "../src/types.js";

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function incompleteEvent(maxOutputTokens: number, reasoningTokens: number): Record<string, unknown> {
  return {
    type: "response.incomplete",
    response: {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      max_output_tokens: maxOutputTokens,
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: maxOutputTokens,
        total_tokens: 100 + maxOutputTokens,
        output_tokens_details: { reasoning_tokens: reasoningTokens },
      },
    },
  };
}

function reasoningRequest(maxTokens: number): CompletionRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    thinking: { enabled: true, effort: "xhigh" },
    maxTokens,
  };
}

describe("meta provider response.incomplete handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces max_output_tokens as a length stop without restarting the request", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body?: string }) => {
      bodies.push(String(init?.body ?? ""));
      return sseResponse([
        { type: "response.created", response: { id: "r1" } },
        incompleteEvent(8192, 8100),
      ]);
    }));
    const tokens: string[] = [];
    const streamMethod = metaProvider.stream;
    expect(streamMethod).toBeDefined();
    const result = await streamMethod!(
      reasoningRequest(8192),
      { apiKey: "test-key-12345" },
      (token) => tokens.push(token),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).max_output_tokens).toBe(8192);
    expect(result.finishReason).toBe("length");
    expect(result.usage?.completionTokens).toBe(8192);
    expect(tokens).toEqual([]);
  });

  it("never spends hidden retry admissions for repeated budget exhaustion", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return sseResponse([incompleteEvent(8192, 8100)]);
    }));
    const streamMethod = metaProvider.stream;
    const result = await streamMethod!(
      reasoningRequest(8192),
      { apiKey: "test-key-12345" },
      () => {},
    );
    expect(calls).toBe(1);
    expect(result.finishReason).toBe("length");
    expect(result.usage?.reasoningTokens).toBe(8100);
  });

  it("returns partial output instead of throwing when the stream ends incomplete", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return sseResponse([
        { type: "response.output_text.delta", delta: "partial answer" },
        incompleteEvent(8192, 100),
      ]);
    }));
    const streamMethod = metaProvider.stream;
    const result = await streamMethod!(
      reasoningRequest(8192),
      { apiKey: "test-key-12345" },
      () => {},
    );
    expect(calls).toBe(1);
    expect(result.text).toContain("partial answer");
    expect(result.finishReason).toBe("length");
  });

  it("returns already-streamed reasoning exactly once with the length stop", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return sseResponse([
        { type: "response.created", response: { id: "r-published" } },
        { type: "response.reasoning_summary_text.delta", delta: "visible reasoning trace" },
        incompleteEvent(8192, 8100),
      ]);
    }));
    const tokens: string[] = [];
    const reasoningDeltas: string[] = [];
    const streamMethod = metaProvider.stream;
    const result = await streamMethod!(
      {
        ...reasoningRequest(8192),
        onStreamEvent: (event) => {
          if (event.type === "reasoning_delta") reasoningDeltas.push(event.text);
        },
      },
      { apiKey: "test-key-12345" },
      (token) => tokens.push(token),
    );
    expect(calls).toBe(1);
    expect(result.finishReason).toBe("length");
    const joined = reasoningDeltas.join("");
    expect(joined).toContain("visible reasoning trace");
    expect(joined.split("visible reasoning trace").length - 1).toBe(1);
    expect(result.reasoningBlock?.text).toBe("visible reasoning trace");
    expect(tokens.join("")).toBe("");
  });

  it("keeps encrypted reasoning artifacts on an incomplete response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "reasoning-1",
            type: "reasoning",
            encrypted_content: "opaque-state",
            summary: [{ type: "summary_text", text: "preserved summary" }],
          },
        },
        incompleteEvent(8192, 8100),
      ]),
    ));
    const streamMethod = metaProvider.stream;
    const result = await streamMethod!(
      reasoningRequest(8192),
      { apiKey: "test-key-12345" },
      () => {},
    );

    expect(result.finishReason).toBe("length");
    expect(result.reasoningBlock?.text).toContain("preserved summary");
    expect(result.reasoningArtifacts).toHaveLength(1);
    expect(result.reasoningArtifacts?.[0]?.kind).toBe("encrypted");
  });

  it("complete() surfaces an incomplete max_output_tokens response without retrying", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body?: string }) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 8192,
          total_tokens: 8292,
          output_tokens_details: { reasoning_tokens: 8100 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const result = await metaProvider.complete(
      reasoningRequest(8192),
      { apiKey: "test-key-12345" },
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).max_output_tokens).toBe(8192);
    expect(result.finishReason).toBe("length");
    expect(result.usage?.completionTokens).toBe(8192);
  });
});
