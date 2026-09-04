import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  repairTruncatedToolArguments,
} from "../../src/llm/tool-wire/argument-repair.js";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
} from "../../src/llm/tool-protocol.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
} from "../../src/llm/http.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";

const BASE_URL = "https://gateway.test/v1";

function responsesJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatJson(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function responsesCompleted(text: string): Response {
  return responsesJson({
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  });
}

function chatSse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function routeByPath(
  handler: (path: string, init: RequestInit) => Response,
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.includes("/responses")
      ? "responses"
      : url.includes("/chat/completions")
        ? "chat"
        : "other";
    return handler(path, init ?? {});
  }) as unknown as typeof fetch;
}

function completeOptions(model: string) {
  return {
    provider: "Gateway",
    providerId: "bynara" as const,
    baseUrl: BASE_URL,
    apiKey: "key-123",
    model,
    messages: [{ role: "user" as const, content: "hi" }],
    responsesFirst: true,
  };
}

async function requestBody(init: RequestInit): Promise<Record<string, unknown>> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("repairTruncatedToolArguments", () => {
  it("closes an unterminated string", () => {
    expect(repairTruncatedToolArguments('{"command": "echo hi')).toBe(
      '{"command": "echo hi"}',
    );
  });

  it("closes nested containers and strips dangling separators", () => {
    expect(repairTruncatedToolArguments('{"a": [1,')).toBe('{"a": [1]}');
    expect(repairTruncatedToolArguments('{"a": "b", ')).toBe('{"a": "b"}');
    expect(repairTruncatedToolArguments('{"a":')).toBe('{"a":null}');
  });

  it("rejects buffers it cannot restore", () => {
    expect(repairTruncatedToolArguments("}")).toBeUndefined();
    expect(repairTruncatedToolArguments('{"a": ]')).toBeUndefined();
    expect(repairTruncatedToolArguments('{"a": 1}')).toBeUndefined();
  });
});

describe("tool call finalization never persists unreplayable arguments", () => {
  it("repairs a truncated streamed buffer", () => {
    const state = new Map();
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "call_1",
      function: { name: "shell", arguments: '{"command": "ls -' },
    });
    const [call] = finalizeOpenAiToolCalls(state);
    expect(call?.rawArguments).toBe('{"command": "ls -"}');
  });

  it("drops raw arguments for unrecoverable buffers so the wire falls back to sanitized args", () => {
    const state = new Map();
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "call_1",
      function: { name: "shell", arguments: "}" },
    });
    const [call] = finalizeOpenAiToolCalls(state);
    expect(call?.rawArguments).toBeUndefined();
    expect(call?.args._parseError).toBe(true);
  });
});

describe("responses-first transport", () => {
  beforeEach(() => {
    resetResponsesWireStatesForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attempts /responses first and maps the result", async () => {
    const fetchMock = routeByPath((path) =>
      path === "responses" ? responsesCompleted("hello") : chatJson("nope"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleComplete(completeOptions("m1"));

    expect(result.text).toBe("hello");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE_URL}/responses`);
    const body = await requestBody(fetchMock.mock.calls[0]![1] as RequestInit);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(String(body.prompt_cache_key)).toMatch(/^clai-/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to chat completions when the endpoint is missing and remembers it", async () => {
    const fetchMock = routeByPath((path) =>
      path === "responses"
        ? responsesJson({ error: { message: "unknown path" } }, 404)
        : chatJson("chat-ok"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await openAiCompatibleComplete(completeOptions("m2"));
    expect(first.text).toBe("chat-ok");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/responses");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/chat/completions");

    const second = await openAiCompatibleComplete(completeOptions("m2"));
    expect(second.text).toBe("chat-ok");
    const responsesCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/responses"),
    );
    expect(responsesCalls).toHaveLength(1);
  });

  it("retries once without optional extras when the provider rejects them", async () => {
    const fetchMock = routeByPath((path, init) => {
      if (path !== "responses") return chatJson("nope");
      const body = init.body as string;
      if (body.includes("prompt_cache_key")) {
        return responsesJson(
          { error: { message: "Unknown parameter: prompt_cache_key" } },
          400,
        );
      }
      return responsesCompleted("bare-ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleComplete(completeOptions("m3"));

    expect(result.text).toBe("bare-ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = await requestBody(
      fetchMock.mock.calls[1]![1] as RequestInit,
    );
    expect(retryBody.prompt_cache_key).toBeUndefined();
    expect(retryBody.store).toBeUndefined();
    expect(retryBody.include).toBeUndefined();
  });

  it("falls back to chat completions when the probe fails with an unreliable status", async () => {
    const fetchMock = routeByPath((path) =>
      path === "responses"
        ? responsesJson({ error: { message: "Internal server error" } }, 500)
        : chatJson("chat-ok"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleComplete(completeOptions("m8"));

    expect(result.text).toBe("chat-ok");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/responses");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/chat/completions");
  });

  it("falls back to chat completions when the bare retry fails with an unreliable status", async () => {
    const fetchMock = routeByPath((path, init) => {
      if (path !== "responses") return chatJson("chat-ok");
      const body = init.body as string;
      if (body.includes("prompt_cache_key")) {
        return responsesJson(
          { error: { message: "Unknown parameter: prompt_cache_key" } },
          400,
        );
      }
      return responsesJson(
        { error: { message: "Internal server error" } },
        500,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleComplete(completeOptions("m9"));

    expect(result.text).toBe("chat-ok");
    const responsesCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/responses"),
    );
    expect(responsesCalls).toHaveLength(2);
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain(
      "/chat/completions",
    );
  });

  it("propagates request-content errors instead of falling back", async () => {
    const fetchMock = routeByPath((path) =>
      path === "responses"
        ? responsesJson(
            { error: { message: "`arguments` must be valid JSON" } },
            400,
          )
        : chatJson("nope"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openAiCompatibleComplete(completeOptions("m4")),
    ).rejects.toThrow(/arguments/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams over /responses and falls back to the chat stream when unsupported", async () => {
    const fetchMock = routeByPath((path) =>
      path === "responses"
        ? responsesJson({ error: { message: "no route" } }, 404)
        : chatSse("stream-ok"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens: string[] = [];
    const result = await openAiCompatibleStream({
      ...completeOptions("m5"),
      onToken: (token) => tokens.push(token),
    });

    expect(result.text).toBe("stream-ok");
    expect(tokens.join("")).toBe("stream-ok");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/responses");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/chat/completions");
  });

  it("falls back when the endpoint answers with a chat-shaped payload", async () => {
    const fetchMock = routeByPath((path) =>
      path === "responses" ? chatJson("not-responses") : chatJson("chat-ok"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleComplete(completeOptions("m6"));

    expect(result.text).toBe("chat-ok");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/chat/completions");
  });

  it("does not touch /responses when the transport is not opted in", async () => {
    const fetchMock = routeByPath((path) =>
      path === "responses" ? responsesCompleted("nope") : chatJson("chat-ok"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleComplete({
      ...completeOptions("m7"),
      responsesFirst: undefined,
    });

    expect(result.text).toBe("chat-ok");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/chat/completions");
  });
});
