import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSseFrameAssembler,
  openAiCompatibleStream,
  readStreamLines,
} from "../src/llm/http.js";

/** LLM-011: abort surfaces as an error, readers are released, error frames throw. */

function sseResponse(frames: string[], onCancel?: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function stubFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseOptions = {
  provider: "test",
  providerId: "openai" as const,
  baseUrl: "https://example.invalid/v1",
  apiKey: "k",
  model: "gpt-4o-mini",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("openAiCompatibleStream error frames", () => {
  it("throws when the gateway sends an error frame mid-stream", async () => {
    stubFetch(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {"error":{"message":"upstream overloaded","type":"overloaded_error"}}\n\n',
      ]),
    );
    await expect(
      openAiCompatibleStream({ ...baseOptions, onToken: () => {} }),
    ).rejects.toThrow(/stream error: upstream overloaded/);
  });

  it("still tolerates malformed keepalive frames", async () => {
    stubFetch(
      sseResponse([
        "data: {not json}\n\n",
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const result = await openAiCompatibleStream({
      ...baseOptions,
      onToken: () => {},
    });
    expect(result.text).toBe("ok");
  });

  it("releases the response body on the success path", async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    stubFetch(response);
    await openAiCompatibleStream({ ...baseOptions, onToken: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    // The reader lock used to be held past [DONE], keeping the socket alive.
    expect(response.body?.locked).toBe(false);
  });
});

describe("cumulative stream snapshots", () => {
  it("normalizes long content snapshots without touching short repeated tokens", async () => {
    const first = "a".repeat(64);
    stubFetch(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: `${first}tail` } }] })}\n\n`,
        'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const result = await openAiCompatibleStream({
      ...baseOptions,
      onToken: () => {},
    });
    expect(result.text).toBe(`${first}tail!!`);
  });

  it("normalizes reasoning snapshots independently from visible content", async () => {
    const reasoning = "r".repeat(64);
    stubFetch(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `${reasoning}end` } }] })}\n\n`,
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events: Array<{ type: string; text?: string }> = [];
    const tokens: string[] = [];
    const result = await openAiCompatibleStream({
      ...baseOptions,
      onToken: (token: string) => tokens.push(token),
      onStreamEvent: (event) => {
        if (event.type === "reasoning_delta") {
          events.push({ type: event.type, text: event.text });
        }
      },
    });
    expect(result.text).toBe("answer");
    expect(tokens.join("")).toBe("answer");
    expect(events.map((event) => event.text).join("")).toBe(`${reasoning}end`);
    expect(result.reasoningBlock?.text).toBe(`${reasoning}end`);
  });
});

describe("readStreamLines caller abort", () => {
  it("throws instead of ending cleanly when the caller aborts", async () => {
    const controller = new AbortController();
    const response = sseResponse([
      "data: one\n",
      "data: two\n",
    ]);
    const lines: string[] = [];
    await expect(
      (async () => {
        for await (const line of readStreamLines(response, {
          signal: controller.signal,
        })) {
          lines.push(line);
          controller.abort();
        }
      })(),
    ).rejects.toThrow();
  });

  it("throws when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = sseResponse(["data: one\n"]);
    await expect(
      (async () => {
        for await (const _line of readStreamLines(response, {
          signal: controller.signal,
        })) {
          // no-op
        }
      })(),
    ).rejects.toThrow();
  });
});


describe("multi-line SSE frames", () => {
  it("reassembles a payload split across several data: lines", async () => {
    stubFetch(
      sseResponse([
        'data: {"choices":[{"delta":\n',
        'data: {"content":"split"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const tokens: string[] = [];
    const result = await openAiCompatibleStream({
      ...baseOptions,
      onToken: (token) => tokens.push(token),
    });
    expect(result.text).toBe("split");
    expect(tokens.join("")).toBe("split");
  });

  it("drops an unterminated fragment instead of corrupting the next frame", () => {
    const frames = createSseFrameAssembler();
    expect(frames.pushLine('data: {"choices":[{"delta":')).toBeUndefined();
    // Blank line terminates the malformed event.
    expect(frames.pushLine("")).toBeUndefined();
    expect(frames.pushLine('data: {"ok":true}')).toBe('{"ok":true}');
  });

  it("passes single-line frames straight through", () => {
    const frames = createSseFrameAssembler();
    expect(frames.pushLine('data: {"a":1}')).toBe('{"a":1}');
    expect(frames.pushLine("data: [DONE]")).toBe("[DONE]");
    expect(frames.pushLine(": keepalive comment")).toBeUndefined();
  });
});

/**
 * A model writing a large file produces one very large `tool_calls` argument
 * string, and the tool-call parsers in front of self-hosted runtimes buffer that
 * whole string before emitting it. The stream therefore delivers prose, then
 * goes quiet for as long as the generation takes.
 *
 * The watchdog used to be re-armed only by content deltas, so it aborted these
 * healthy streams at `firstToken + idleTimeoutMs`, reported the abort as a
 * network failure, and burned three identical retries that each re-generated
 * the same prefix before one happened to land inside the window.
 */
describe("openAiCompatibleStream stall watchdog", () => {
  /** Emits `frames`, spacing them with SSE keepalive comments. */
  function drip(
    frames: string[],
    gapMs: number,
    keepaliveMs?: number,
  ): Response {
    const encoder = new TextEncoder();
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (keepaliveMs !== undefined) {
          keepalive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              // stream already closed
            }
          }, keepaliveMs);
        }
        for (const frame of frames) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          controller.enqueue(encoder.encode(frame));
        }
        if (keepalive) clearInterval(keepalive);
        controller.close();
      },
      cancel() {
        if (keepalive) clearInterval(keepalive);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("keeps a stream alive while keepalives arrive between content deltas", async () => {
    stubFetch(
      drip(
        [
          'data: {"choices":[{"delta":{"content":"Writing the full main.js now."}}]}\n\n',
          // Long silence in model output while the runtime buffers the tool call.
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_write","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ],
        60,
        5,
      ),
    );
    const result = await openAiCompatibleStream({
      ...baseOptions,
      onToken: () => {},
      // Byte budget far shorter than the gap between content deltas: only the
      // keepalives can carry the stream across it.
      initialIdleTimeoutMs: 40,
      idleTimeoutMs: 40,
      outputIdleTimeoutMs: 60_000,
    });
    expect(result.toolCalls?.[0]?.name).toBe("fs.write");
  });

  it("survives a long byte-silent buffered tool call within the configured budget", async () => {
    stubFetch(
      drip(
        [
          'data: {"choices":[{"delta":{"content":"Writing the full main.js now."}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs_write","arguments":"{\\"path\\":\\"main.js\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ],
        70,
      ),
    );
    const result = await openAiCompatibleStream({
      ...baseOptions,
      onToken: () => {},
      // The 70ms body silence is longer than the old scaled 40ms budget but
      // below the new buffered-generation allowance represented by 120ms.
      initialIdleTimeoutMs: 120,
      idleTimeoutMs: 120,
      outputIdleTimeoutMs: 1_000,
    });
    expect(result.toolCalls?.[0]?.name).toBe("fs.write");
  });

  it("reports a stall on a live connection as a stall, not a dropped connection", async () => {
    stubFetch(
      drip(
        [
          'data: {"choices":[{"delta":{"content":"Writing the full main.js now."}}]}\n\n',
          "data: [DONE]\n\n",
        ],
        400,
        5,
      ),
    );
    await expect(
      openAiCompatibleStream({
        ...baseOptions,
        onToken: () => {},
        initialIdleTimeoutMs: 1_000,
        idleTimeoutMs: 1_000,
        // Output budget expires while the keepalives still flow.
        outputIdleTimeoutMs: 120,
      }),
    ).rejects.toThrow(/stream stalled — no model output/i);
  });

  it("reports a route that never answered as a transport timeout", async () => {
    stubFetch(
      drip(['data: {"choices":[{"delta":{"content":"late"}}]}\n\n'], 300),
    );
    await expect(
      openAiCompatibleStream({
        ...baseOptions,
        onToken: () => {},
        initialIdleTimeoutMs: 40,
        idleTimeoutMs: 40,
        outputIdleTimeoutMs: 60_000,
      }),
    ).rejects.toThrow(/request timed out before any response/i);
  });
});
