import { afterEach, describe, expect, it, vi } from "vitest";
import { freeProvider } from "../../src/llm/free.js";

function jsonResponsesMock() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi there" }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function chatCompletionsMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/responses")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
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

describe("free provider Responses dialect (muse-spark on zen)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes a muse-spark zen model to /responses with a Responses-shaped body", async () => {
    const fetchMock = jsonResponsesMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await freeProvider.complete(
      {
        model: "free-1/muse-spark-1.2-contributor-free",
        messages: [{ role: "user", content: "hi" }],
      },
      {},
    );

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://opencode.ai/zen/v1/responses",
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      model?: string;
      input?: unknown;
      messages?: unknown;
      max_output_tokens?: number;
    };
    expect(body.model).toBe("muse-spark-1.2-contributor-free");
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.messages).toBeUndefined();
    expect(typeof body.max_output_tokens).toBe("number");
    expect(result.text).toBe("hi there");
    expect(result.provider).toBe("free");
    expect(result.model).toBe("free-1/muse-spark-1.2-contributor-free");
  });

  it("sends no Authorization header for a keyless muse-spark request", async () => {
    const fetchMock = jsonResponsesMock();
    vi.stubGlobal("fetch", fetchMock);

    await freeProvider.complete(
      {
        model: "free-1/muse-spark-1.2-contributor-free",
        messages: [{ role: "user", content: "hi" }],
      },
      {},
    );

    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.headers).toMatchObject({ accept: "application/json" });
  });

  it("sends the Authorization header when a key is configured", async () => {
    const fetchMock = jsonResponsesMock();
    vi.stubGlobal("fetch", fetchMock);

    await freeProvider.complete(
      {
        model: "free-1/muse-spark-1.2-contributor-free",
        messages: [{ role: "user", content: "hi" }],
      },
      { apiKey: "zen-key-123" },
    );

    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(request.headers).toMatchObject({
      authorization: "Bearer zen-key-123",
    });
  });

  it("streams a muse-spark zen model over /responses SSE without an auth header", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { type: "response.created", response: { id: "r1" } },
        { type: "response.output_text.delta", delta: "hel" },
        { type: "response.output_text.delta", delta: "lo" },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
          },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens: string[] = [];
    const result = await freeProvider.stream(
      {
        model: "free-1/muse-spark-1.2-contributor-free",
        messages: [{ role: "user", content: "hi" }],
      },
      {},
      (token) => tokens.push(token),
    );

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://opencode.ai/zen/v1/responses",
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      input?: unknown;
      stream?: boolean;
    };
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.stream).toBe(true);
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.headers).toMatchObject({ accept: "text/event-stream" });
    expect(tokens.join("")).toBe("hello");
    expect(result.text).toBe("hello");
    expect(result.model).toBe("free-1/muse-spark-1.2-contributor-free");
  });

  it("uses /chat/completions directly for a non-muse-spark zen model without probing /responses", async () => {
    const fetchMock = chatCompletionsMock();
    vi.stubGlobal("fetch", fetchMock);

    await freeProvider.complete(
      {
        model: "free-1/deepseek-v4-flash-free",
        messages: [{ role: "user", content: "hi" }],
      },
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      messages?: unknown;
      input?: unknown;
    };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.input).toBeUndefined();
  });

  it("probes /responses first for the kilo source (free-2), then keeps /chat/completions when absent", async () => {
    const fetchMock = chatCompletionsMock();
    vi.stubGlobal("fetch", fetchMock);

    await freeProvider.complete(
      {
        model: "free-2/nvidia/nemotron-3-ultra-550b-a55b:free",
        messages: [{ role: "user", content: "hi" }],
      },
      {},
    );

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.kilo.ai/api/gateway/responses",
    );
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://api.kilo.ai/api/gateway/chat/completions",
    );
    const request = fetchMock.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      model?: string;
      messages?: unknown;
      input?: unknown;
    };
    expect(body.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.input).toBeUndefined();
  });

  it("keeps a kilo muse-spark-like id off the zen responses dialect", async () => {
    const fetchMock = chatCompletionsMock();
    vi.stubGlobal("fetch", fetchMock);

    await freeProvider.complete(
      {
        model: "free-2/muse-spark-1.2:free",
        messages: [{ role: "user", content: "hi" }],
      },
      {},
    );

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.kilo.ai/api/gateway/responses",
    );
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://api.kilo.ai/api/gateway/chat/completions",
    );
    const request = fetchMock.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { input?: unknown };
    expect(body.input).toBeUndefined();
  });
});
