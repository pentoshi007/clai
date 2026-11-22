import { afterEach, describe, expect, it, vi } from "vitest";

import { kiroProvider, resetKiroModelCacheForTesting } from "../../src/llm/kiro.js";
import {
  encodeKiroFrame,
  installKiroFetch,
  isKiroCatalogRequest,
  isKiroCreateResponseRequest,
  kiroCatalogResponse,
  kiroSseResponse,
  kiroStreamResponse,
  requestBody,
} from "../helpers/kiro-fixtures.js";

const KEY = "kiro-create-response-test-key";

function controllableSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(inner) {
      controller = inner;
    },
  });
  const encoder = new TextEncoder();
  return {
    stream,
    push(event: unknown) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function stubGeneration(
  handler: (input: unknown, init?: RequestInit) => Response | Promise<Response>,
) {
  return installKiroFetch(async (input, init) => {
    if (isKiroCatalogRequest(input, init)) return kiroCatalogResponse([]);
    return handler(input, init);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetKiroModelCacheForTesting();
});

describe("Kiro CreateResponse protocol", () => {
  it("sends the kiro-cli 3.5.0 identity and the /v1/responses body", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    stubGeneration((input, init) => {
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: requestBody(init),
      };
      return kiroSseResponse([
        { type: "response.output_text.delta", delta: "hi" },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    });

    const result = await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hello" },
        ],
        tools: [{
          name: "fs_read",
          wireName: "fs_read",
          description: "read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        }],
      },
      { apiKey: KEY },
    );

    expect(result.text).toBe("hi");
    expect(result.api).toBe("create-response");
    expect(captured?.url).toBe("https://runtime.us-east-1.kiro.dev/v1/responses");
    expect(captured?.headers.get("content-type")).toBe("application/json");
    expect(captured?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(captured?.headers.get("x-amzn-kiro-origin")).toBe("KIRO_CLI");
    expect(captured?.headers.get("x-amzn-codewhisperer-optout")).toBe("true");
    expect(captured?.headers.get("user-agent")).toBe(
      "KiroCLI/3.5.0 KAS/0.66.119 os/" + process.platform +
        " md/appVersion-3.5.0 app/AmazonQ-For-CLI acp-client/kiro-cli",
    );

    expect(captured?.body.model).toBe("claude-sonnet-4.5");
    expect(captured?.body.stream).toBe(true);
    expect(captured?.body.origin).toBe("KIRO_CLI");
    expect(captured?.body.instructions).toBeUndefined();
    expect(captured?.body.input).toEqual([
      { role: "user", content: "be brief\n\nhello" },
    ]);
    expect(captured?.body.tools).toEqual([{
      type: "function",
      name: "fs_read",
      description: "read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }]);
    const metadata = captured?.body.metadata as Record<string, string>;
    expect(metadata["kiro:agent_mode"]).toBe("vibe");
    expect(metadata["kiro:mode_identifier"]).toBe("default-v2");
    expect(metadata["kiro:conversation_id"]).toBe(metadata["kiro:root_conversation_id"]);
    expect(metadata["kiro:agent_continuation_id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("forwards text, reasoning and tool deltas before the stream closes", async () => {
    const sse = controllableSse();
    stubGeneration(() => sseResponse(sse.stream));

    const tokens: string[] = [];
    const reasoning: string[] = [];
    const toolDeltas: Array<{ id: string; argumentsBytes: number }> = [];
    const pending = kiroProvider.stream(
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "go" }],
        onStreamEvent: (event) => {
          if (event.type === "reasoning_delta") reasoning.push(event.text);
        },
        onToolCallDelta: (delta) => {
          toolDeltas.push({ id: delta.id, argumentsBytes: delta.argumentsBytes });
        },
      },
      { apiKey: KEY },
      (token) => tokens.push(token),
    );

    await settle();
    expect(tokens).toEqual([]);

    sse.push({ type: "response.output_text.delta", delta: "Hel" });
    await settle();
    expect(tokens).toEqual(["Hel"]);

    sse.push({ type: "response.reasoning_text.delta", delta: "thinking" });
    await settle();
    expect(reasoning).toEqual(["thinking"]);

    sse.push({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "call_1", name: "fs_read", arguments: "" },
    });
    sse.push({ type: "response.function_call_arguments.delta", delta: '{"path":"a"}' });
    await settle();
    expect(toolDeltas.at(-1)?.id).toBe("call_1");
    expect(toolDeltas.at(-1)?.argumentsBytes).toBe(12);

    sse.push({ type: "response.output_text.delta", delta: "lo" });
    sse.push({ type: "response.function_call_arguments.done" });
    sse.push({ type: "response.completed", response: { status: "completed" } });
    sse.close();

    const result = await pending;
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(result.text).toBe("Hello");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([{
      id: "call_1",
      name: "fs_read",
      args: { path: "a" },
      rawArguments: '{"path":"a"}',
    }]);
  });

  it("round-trips assistant tool calls and tool results", async () => {
    let body: Record<string, unknown> | undefined;
    stubGeneration((_input, init) => {
      body = requestBody(init);
      return kiroSseResponse([
        { type: "response.output_text.delta", delta: "done" },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    });

    await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [
          { role: "user", content: "read both" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_a", name: "fs_read", args: { path: "a" } },
              { id: "call_b", name: "fs_read", args: { path: "b" } },
            ],
          },
          { role: "tool", toolCallId: "call_a", content: "A" },
          { role: "tool", toolCallId: "call_b", content: "B" },
          { role: "user", content: "summarize" },
        ],
      },
      { apiKey: KEY },
    );

    expect(body?.input).toEqual([
      { role: "user", content: "read both" },
      { type: "function_call", call_id: "call_a", name: "fs_read", arguments: '{"path":"a"}' },
      { type: "function_call", call_id: "call_b", name: "fs_read", arguments: '{"path":"b"}' },
      { type: "function_call_output", call_id: "call_a", output: "A" },
      { type: "function_call_output", call_id: "call_b", output: "B" },
      { role: "user", content: "summarize" },
    ]);
  });

  it("serializes images as input_image data URLs", async () => {
    let body: Record<string, unknown> | undefined;
    stubGeneration((_input, init) => {
      body = requestBody(init);
      return kiroSseResponse([
        { type: "response.output_text.delta", delta: "seen" },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    });

    await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [{
          role: "user",
          content: "what is this",
          images: [{ mediaType: "image/png", dataBase64: "QUJD" }],
        }],
      },
      { apiKey: KEY },
    );

    expect(body?.input).toEqual([{
      role: "user",
      content: [
        { type: "input_text", text: "what is this" },
        { type: "input_image", image_url: "data:image/png;base64,QUJD" },
      ],
    }]);
  });

  it("maps terminal usage, credits and incomplete reasons", async () => {
    stubGeneration(() => kiroSseResponse([
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            "kiro:context_usage_percentage": 42,
            "kiro:credits": { value: 0.5, unit: "credit", unit_plural: "credits" },
          },
        },
      },
    ]));

    const result = await kiroProvider.complete(
      { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "long" }] },
      { apiKey: KEY },
    );

    expect(result.finishReason).toBe("length");
    expect(result.usage?.charges).toEqual([{ amount: 0.5, unit: "credits" }]);
  });

  it("carries the thinking directive into the CreateResponse user turns", async () => {
    let body: Record<string, unknown> | undefined;
    stubGeneration((_input, init) => {
      body = requestBody(init);
      return kiroSseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    });

    await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5-thinking",
        messages: [{ role: "user", content: "solve it" }],
        thinking: { enabled: true, effort: "max" },
      },
      { apiKey: KEY },
    );

    const input = body?.input as Array<{ role: string; content: string }>;
    expect(input[0]?.content).toBe(
      "<thinking_mode>enabled</thinking_mode><max_thinking_length>64000</max_thinking_length>\n\nsolve it",
    );
    expect(body?.reasoning).toBeUndefined();
  });

  it("splits thinking tags that arrive across SSE deltas", async () => {
    stubGeneration(() => kiroSseResponse([
      { type: "response.output_text.delta", delta: "<think" },
      { type: "response.output_text.delta", delta: "ing>\nplan" },
      { type: "response.output_text.delta", delta: "</think" },
      { type: "response.output_text.delta", delta: "ing>answer" },
      { type: "response.completed", response: { status: "completed" } },
    ]));

    const reasoning: string[] = [];
    const result = await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "go" }],
        onStreamEvent: (event) => {
          if (event.type === "reasoning_delta") reasoning.push(event.text);
        },
      },
      { apiKey: KEY },
    );

    expect(reasoning.join("")).toBe("\nplan");
    expect(result.text).toBe("answer");
    expect(result.reasoningBlock?.text).toBe("plan");
  });

  it("falls back to the legacy endpoint when the operation is missing", async () => {
    const urls: string[] = [];
    stubGeneration((input) => {
      urls.push(String(input));
      if (isKiroCreateResponseRequest(input)) {
        return new Response("not found", { status: 404 });
      }
      return kiroStreamResponse([
        encodeKiroFrame(
          { ":event-type": "assistantResponseEvent" },
          { content: "legacy" },
        ),
      ]);
    });

    const result = await kiroProvider.complete(
      { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
      { apiKey: KEY },
    );

    expect(result.api).toBe("generate-assistant-response");
    expect(urls.some((url) => url.endsWith("/v1/responses"))).toBe(true);
    expect(urls.some((url) => url.includes("generateAssistantResponse") || url === "https://runtime.us-east-1.kiro.dev/")).toBe(true);
  });
});

describe("Kiro prompt caching", () => {
  it("keeps the conversation identity and system prefix stable across turns", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubGeneration((_input, init) => {
      bodies.push(requestBody(init));
      return kiroSseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    });

    const system = "You are a careful engineer.";
    const first = "first question";
    await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "system", content: system }, { role: "user", content: first }],
      },
      { apiKey: KEY },
    );
    await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [
          { role: "system", content: system },
          { role: "user", content: first },
          { role: "assistant", content: "answer" },
          { role: "user", content: "follow up" },
        ],
      },
      { apiKey: KEY },
    );

    const firstMeta = bodies[0]?.metadata as Record<string, string>;
    const secondMeta = bodies[1]?.metadata as Record<string, string>;
    expect(secondMeta["kiro:conversation_id"]).toBe(firstMeta["kiro:conversation_id"]);
    expect(secondMeta["kiro:root_conversation_id"]).toBe(firstMeta["kiro:root_conversation_id"]);

    const firstInput = bodies[0]?.input as Array<{ role: string; content: string }>;
    const secondInput = bodies[1]?.input as Array<{ role: string; content: string }>;
    expect(firstInput[0]?.content).toBe(`${system}\n\n${first}`);
    expect(secondInput[0]?.content).toBe(`${system}\n\n${first}`);
  });

  it("reports cache read and write tokens from legacy metrics", async () => {
    stubGeneration((input) => {
      if (isKiroCreateResponseRequest(input)) {
        return new Response("not found", { status: 404 });
      }
      return kiroStreamResponse([
        encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "cached" }),
        encodeKiroFrame(
          { ":event-type": "metricsEvent" },
          {
            inputTokens: 1200,
            outputTokens: 40,
            cacheReadInputTokens: 900,
            cacheWriteInputTokens: 100,
          },
        ),
      ]);
    });

    const result = await kiroProvider.complete(
      { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
      { apiKey: KEY },
    );

    expect(result.usage?.promptTokens).toBe(1200);
    expect(result.usage?.completionTokens).toBe(40);
    expect(result.usage?.cachedPromptTokens).toBe(900);
    expect(result.usage?.cacheCreationTokens).toBe(100);
    expect(result.usage?.uncachedPromptTokens).toBe(300);
  });
});
