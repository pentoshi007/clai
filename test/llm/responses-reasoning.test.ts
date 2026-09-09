import { describe, expect, it, vi } from "vitest";
import { openAiCompatibleStream } from "../../src/llm/http.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import { explabsProvider } from "../../src/llm/explabs.js";
import { explabsBaseUrl } from "../../src/llm/explabs.js";

const BASE_URL = "https://gateway.test/v1";

function sseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
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

function reasoningOnlyTerminalStream(): Response {
  return sseResponse([
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      delta: "The answer is 391.",
    },
    { type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: "The answer is 391." },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "The answer is 391." }] } },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: "I multiplied 17 by 23 to get 391." }],
            encrypted_content: "enc-abc",
          },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "The answer is 391." }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          total_tokens: 18,
          output_tokens_details: { reasoning_tokens: 6 },
        },
      },
    },
  ]);
}

function streamOptions(model: string) {
  return {
    provider: "Experiential Labs",
    providerId: "explabs" as const,
    baseUrl: BASE_URL,
    apiKey: "key-123",
    model,
    messages: [{ role: "user" as const, content: "17*23?" }],
    maxTokens: 64,
    responsesFirst: true,
    reasoning: { enabled: true, effort: "low" },
  };
}

async function requestBody(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("responses stream reasoning handling", () => {
  it("emits reasoning that only arrives in response.completed instead of a private-reasoning note", async () => {
    resetResponsesWireStatesForTesting();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return reasoningOnlyTerminalStream();
    });
    vi.stubGlobal("fetch", fetchMock);

    const reasoningDeltas: string[] = [];
    const tokens: string[] = [];
    const result = await openAiCompatibleStream({
      ...streamOptions("gpt-5.6-luna"),
      onToken: (token) => tokens.push(token),
      onStreamEvent: (event) => {
        if (event.type === "reasoning_delta") reasoningDeltas.push(event.text);
      },
    });

    expect(tokens.join("")).toBe("The answer is 391.");
    expect(result.text).toBe("The answer is 391.");
    expect(reasoningDeltas.join("")).toContain("I multiplied 17 by 23");
    expect(result.reasoningBlock?.text).toContain("I multiplied 17 by 23");
    expect(result.reasoningBlock?.text).not.toMatch(/Reasoning is private/);
    expect(calls).toHaveLength(2);
  });

  it("does not abort and re-request when reasoning arrives after visible content", async () => {
    resetResponsesWireStatesForTesting();
    const fetchMock = vi.fn(async () => reasoningOnlyTerminalStream());
    vi.stubGlobal("fetch", fetchMock);

    await openAiCompatibleStream({
      ...streamOptions("gpt-5.6-luna"),
      onToken: () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the responses result when no reasoning text arrives after visible output was already streamed", async () => {
    resetResponsesWireStatesForTesting();
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/responses")) {
        return sseResponse([
          { type: "response.created", response: { id: "resp_2" } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "msg_2", type: "message", role: "assistant", status: "in_progress", content: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_2",
            output_index: 0,
            delta: "ok",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_2",
              status: "completed",
              output: [
                {
                  id: "msg_2",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "ok" }],
                },
              ],
              usage: {
                input_tokens: 5,
                output_tokens: 3,
                total_tokens: 8,
                output_tokens_details: { reasoning_tokens: 4 },
              },
            },
          },
        ]);
      }
      return sseResponse([
        { choices: [{ delta: { content: "chat-ok" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleStream({
      ...streamOptions("gpt-5.6-luna"),
      onToken: () => {},
    });

    expect(result.text).toBe("ok");
    expect(result.api).toBe("responses");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const preflight = await requestBody(fetchMock.mock.calls[0]?.[1]);
    const real = await requestBody(fetchMock.mock.calls[2]?.[1]);
    expect(preflight.max_output_tokens).toBe(64);
    expect(JSON.stringify(preflight.input)).toContain("smallest positive integer");
    expect(JSON.stringify(real.input)).toContain("17*23?");
  });
});

describe("explabs family routing", () => {
  it("routes native reasoning families to /responses first", async () => {
    resetResponsesWireStatesForTesting();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/responses")) return reasoningOnlyTerminalStream();
      return sseResponse([
        { choices: [{ delta: { content: "chat" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleStream({
      ...streamOptions("gpt-5.6-luna"),
      onToken: () => {},
    });

    expect(result.api).toBe("responses");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/responses");
  });

  it("routes translated families to chat first for cache affinity", async () => {
    resetResponsesWireStatesForTesting();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/responses")) {
        throw new Error("responses must not be called for deepseek");
      }
      return sseResponse([
        { choices: [{ delta: { content: "chat" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await explabsProvider.stream!(
      {
        model: "deepseek-v4-flash-0731",
        messages: [{ role: "user", content: "17*23?" }],
        thinking: { enabled: true, effort: "low" },
      },
      { apiKey: "xpl_testkey0000000000000000000000000000000000000" },
      () => {},
    );

    expect(result.api).toBe("chat-completions");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/chat/completions");
  });

  it("provider stream routes by model family", async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      const url = String(input).replace(explabsBaseUrl, "https://gateway.test/v1");
      seen.push(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (url.includes("/responses")) {
        return reasoningOnlyTerminalStream();
      }
      return sseResponse([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    }) as typeof fetch);

    await explabsProvider.stream!(
      { model: "deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "xpl_testkey0000000000000000000000000000000000000" },
      () => {},
    );
    expect(seen[0]).toContain("/chat/completions");

    await explabsProvider.stream!(
      { model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "xpl_testkey0000000000000000000000000000000000000" },
      () => {},
    );
    expect(seen.at(-1)).toContain("/responses");

    vi.stubGlobal("fetch", realFetch);
  });
});
