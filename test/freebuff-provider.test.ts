import { describe, expect, it, vi } from "vitest";

import type { CompletionRequest } from "../src/types.js";
import { freebuffProvider } from "../src/llm/freebuff.js";

const TOKEN = "freebuff-opaque-token-abcdef123456";
const MODEL = "deepseek/deepseek-v4-flash";

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    provider: "freebuff",
    model: MODEL,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("Freebuff provider server gate", () => {
  it("requires authentication and rejects malformed tokens before any request", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(freebuffProvider.stream!(request(), {}, () => {})).rejects.toThrow(
      /authentication required/i,
    );
    await expect(freebuffProvider.stream!(request(), { apiKey: "short" }, () => {})).rejects.toThrow(
      /authentication required/i,
    );
    await expect(freebuffProvider.complete!(request(), {})).rejects.toThrow(
      /authentication required/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a run and streams even when session admission is refused", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? String(init.body) : "";
      calls.push({ url, body });
      if (url.includes("/freebuff/session/admission")) {
        return new Response(JSON.stringify({ error: "session_superseded" }), { status: 409 });
      }
      if (url.includes("/agent-runs")) {
        if (body.includes('"START"')) {
          return new Response(JSON.stringify({ runId: "run-123" }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const sse = [
        'data: {"choices":[{"delta":{"content":"pong"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
        "data: [DONE]",
      ].join("\n\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens: string[] = [];
    const result = await freebuffProvider.stream!(request(), { apiKey: TOKEN }, (t) => {
      tokens.push(t);
    });

    expect(result.text).toBe("pong");
    expect(tokens.join("")).toBe("pong");
    const completion = calls.find((c) => c.url.includes("/chat/completions"));
    expect(completion?.body).toContain('"run_id":"run-123"');
    expect(calls.some((c) => c.url.includes("/agent-runs") && c.body.includes('"FINISH"'))).toBe(
      true,
    );
  });

  it("completes without streaming when admission is refused", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/freebuff/session/admission")) {
        return new Response(JSON.stringify({ error: "session_superseded" }), { status: 409 });
      }
      if (url.includes("/agent-runs")) {
        return new Response(JSON.stringify({ runId: "run-456" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "pong" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await freebuffProvider.complete!(request(), { apiKey: TOKEN });
    expect(result.text).toBe("pong");
  });

  it("falls back to the static catalog without a token", async () => {
    const models = await freebuffProvider.listModels!({});
    expect(models).toContain(MODEL);
  });
});
