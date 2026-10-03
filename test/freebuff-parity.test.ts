import { afterEach, describe, expect, it, vi } from "vitest";
import { freebuffProvider } from "../src/llm/freebuff.js";
import { disposeFreebuffSessionManager } from "../src/llm/freebuff-session.js";
import type { CompletionRequest } from "../src/types.js";

const TOKEN = "freebuff-parity-token-12345678";
const MODEL = "deepseek/deepseek-v4-flash";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fixture(chat?: (call: Call) => Response | Promise<Response>, admission?: Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
      signal: init?.signal,
    };
    calls.push(call);
    if (call.url.endsWith("/session/admission")) {
      return admission?.clone() ?? json({ status: "active", instanceId: "cli:parity", model: MODEL, remainingMs: 3_600_000 });
    }
    if (call.url.endsWith("/session/attempt")) return json({ status: "ended" });
    if (call.url.endsWith("/agent-runs")) return json({ runId: "parity-run" });
    if (chat) return chat(call);
    if (call.body.stream) return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    return json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  }));
  return calls;
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return { provider: "freebuff", model: MODEL, messages: [{ role: "user", content: "hello" }], ...overrides };
}

function chats(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.endsWith("/chat/completions"));
}

function finishes(calls: Call[]): Call[] {
  return calls.filter((call) => call.body.action === "FINISH");
}

afterEach(async () => {
  await disposeFreebuffSessionManager();
  vi.unstubAllGlobals();
});

describe("installed Freebuff CLI transport parity", () => {
  it("omits SDK-unset controls, uses max_tokens for all hosted models and content parts for users", async () => {
    const calls = fixture();
    await freebuffProvider.complete(request(), { apiKey: TOKEN });
    const body = chats(calls)[0]!.body;
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("stream");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }]);
    expect(body.provider).toEqual({ allow_fallbacks: false });
    await freebuffProvider.stream!(request({ model: "openai/gpt-5.6-luna", maxTokens: 2048, temperature: 0.7 }), { apiKey: TOKEN }, () => {});
    const streamed = chats(calls)[1]!.body;
    expect(streamed.max_tokens).toBe(2048);
    expect(streamed.temperature).toBe(0.7);
    expect(streamed).not.toHaveProperty("max_completion_tokens");
    expect(streamed).not.toHaveProperty("stream_options");
    expect(streamed.stream).toBe(true);
  });

  it("retains one claim and client identity across turns until explicit shutdown", async () => {
    const calls = fixture();
    await freebuffProvider.complete(request(), { apiKey: TOKEN });
    await freebuffProvider.stream!(request(), { apiKey: TOKEN }, () => {});
    expect(calls.filter((call) => call.url.endsWith("/session/admission"))).toHaveLength(1);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    const metadata = chats(calls).map((call) => call.body.codebuff_metadata as Record<string, unknown>);
    expect(metadata[0]!.client_id).toBe(metadata[1]!.client_id);
    expect(metadata[0]).toMatchObject({ freebuff_instance_id: "cli:parity", freebuff_multi_session: "1", surface: "cli" });
    await disposeFreebuffSessionManager();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(finishes(calls)).toHaveLength(2);
    expect(finishes(calls)[0]!.body).toMatchObject({ status: "completed", totalSteps: 1, steps: expect.any(Array) });
  });

  it("reassembles streamed tools and replays their results and reasoning on the next request", async () => {
    let generation = 0;
    const calls = fixture(() => {
      generation += 1;
      if (generation > 1) return json({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
      const frames = [
        { choices: [{ delta: { reasoning_content: "inspect", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } } },
      ];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const tools = [{ name: "read.file", wireName: "read_file", description: "Read a file", parameters: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } }];
    const first = await freebuffProvider.stream!(request({ tools }), { apiKey: TOKEN }, () => {});
    expect(first.toolCalls).toMatchObject([{ id: "call-1", name: "read.file", args: { path: "a.txt" } }]);
    expect(first.reasoningBlock?.text).toBe("inspect");
    expect(first.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, cachedPromptTokens: 4 });
    const second = await freebuffProvider.complete(request({
      tools,
      messages: [
        { role: "user", content: "Read a.txt" },
        { role: "assistant", content: "", toolCalls: first.toolCalls, reasoningArtifacts: first.reasoningArtifacts },
        { role: "tool", content: "file content", toolCallId: "call-1" },
      ],
    }), { apiKey: TOKEN });
    expect(second.text).toBe("done");
    const history = chats(calls)[1]!.body.messages as Array<Record<string, unknown>>;
    expect(history[1]).toMatchObject({ role: "assistant", reasoning_content: "inspect", tool_calls: [{ id: "call-1" }] });
    expect(history[2]).toMatchObject({ role: "tool", tool_call_id: "call-1", content: "file content" });
    expect(calls.filter((call) => call.url.endsWith("/session/admission"))).toHaveLength(1);
  });

  it("queues a model switch until the current provider run finishes", async () => {
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let generations = 0;
    const calls = fixture(async () => {
      if (++generations === 1) await pending;
      return json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    });
    const first = freebuffProvider.complete(request(), { apiKey: TOKEN });
    await vi.waitFor(() => expect(chats(calls)).toHaveLength(1));
    const second = freebuffProvider.complete(request({ model: "mimo/mimo-v2.5" }), { apiKey: TOKEN });
    await Promise.resolve();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    finish();
    await Promise.all([first, second]);
    const ended = calls.findIndex((call) => call.body.action === "FINISH");
    const released = calls.findIndex((call) => call.method === "DELETE");
    expect(released).toBeGreaterThan(ended);
    expect(calls.filter((call) => call.url.endsWith("/session/admission"))).toHaveLength(2);
    expect(chats(calls)).toHaveLength(2);
  });

  it("stops before run registration or generation on admission refusal", async () => {
    const calls = fixture(undefined, json({ status: "consent_required", walletConsent: { price: 5, walletSpend: 5 } }, 409));
    await expect(freebuffProvider.complete(request(), { apiKey: TOKEN })).rejects.toThrow(/wallet Freebucks/);
    expect(chats(calls)).toHaveLength(0);
    expect(calls.some((call) => call.body.action === "START")).toBe(false);
  });

  it("finishes a cancelled run exactly once with a fresh cleanup signal", async () => {
    const controller = new AbortController();
    const calls = fixture(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(freebuffProvider.complete(request({ signal: controller.signal }), { apiKey: TOKEN })).rejects.toThrow();
    expect(finishes(calls)).toHaveLength(1);
    expect(finishes(calls)[0]!.body.status).toBe("cancelled");
    expect(finishes(calls)[0]!.signal?.aborted).toBe(false);
  });

  it("logs failure details and completed request steps without releasing the live slot", async () => {
    const calls = fixture(() => json({ error: { message: "upstream unavailable" } }, 503));
    await expect(freebuffProvider.complete(request(), { apiKey: TOKEN })).rejects.toThrow(/503/);
    const finish = finishes(calls)[0]!.body;
    expect(finish.status).toBe("failed");
    expect(finish.errorMessage).toEqual(expect.stringContaining("503"));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });
});
