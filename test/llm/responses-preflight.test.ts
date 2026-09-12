import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAiCompatibleComplete, openAiCompatibleStream } from "../../src/llm/http.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import { selectResponsesWire, type ResponsesSelection } from "../../src/llm/wire/responses-preflight.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { OperationUsageRecorder, runGenerationAttempt } from "../../src/llm/operation-usage.js";

const options = {
  provider: "Gateway",
  providerId: "agentrouter" as const,
  baseUrl: "https://preflight.test/v1",
  apiKey: "test-key",
  model: "glm-5.3",
  messages: [{ role: "user" as const, content: `PRIVATE HISTORY ${"long context ".repeat(10_000)}` }],
  reasoning: { enabled: true, effort: "high" as const },
  reasoningStyle: "agentrouter" as const,
  temperature: 0.4,
  maxTokens: 8192,
  headers: { "x-custom-route": "preferred", "user-agent": "test-agent" },
  responsesFirst: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function reply(wire: "responses" | "chat", streaming: boolean, text: string, reasoning = "", privateReasoning = false): Response {
  const promptTokens = text === "REAL" ? 115_000 : 12;
  if (wire === "responses") {
    const response = {
      status: "completed",
      output: [
        ...(reasoning || privateReasoning ? [{ type: "reasoning", id: "r1", summary: reasoning ? [{ type: "summary_text", text: reasoning }] : [], encrypted_content: "opaque-private-data" }] : []),
        { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      ],
      usage: { input_tokens: promptTokens, output_tokens: 20, total_tokens: promptTokens + 20, output_tokens_details: { reasoning_tokens: 10 } },
    };
    return streaming ? sse([{ type: "response.completed", response }]) : json(response);
  }
  const message = { content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) };
  const usage = { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20, completion_tokens_details: { reasoning_tokens: 10 } };
  return streaming ? sse([
    { choices: [{ delta: message }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage },
    "[DONE]",
  ]) : json({ choices: [{ message, finish_reason: "stop" }], usage });
}

beforeEach(() => resetResponsesWireStatesForTesting());
afterEach(() => {
  resetResponsesWireStatesForTesting();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("small production-format capability preflight", () => {
  it.each([false, true])("chooses visible Chat reasoning before sending history, streaming=%s", async (streaming) => {
    const calls: { wire: "responses" | "chat"; body: any; headers: Headers; real: boolean }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      const wire = String(url).endsWith("/responses") ? "responses" : "chat";
      const body = JSON.parse(String(init.body));
      const real = String(init.body).includes("PRIVATE HISTORY");
      calls.push({ wire, body, headers: new Headers(init.headers), real });
      return reply(wire, streaming, real ? "REAL" : "PROBE", wire === "chat" ? (real ? "ACTUAL REASONING" : "PROBE REASONING") : "", wire === "responses");
    }));
    const tokens: string[] = [];
    const events: unknown[] = [];
    const toolDelta = vi.fn();
    const replayObserver = vi.fn();
    const request = { ...options, reasoningArtifactReplayObserver: replayObserver };
    const run = () => withSessionAffinity("session-real", () => streaming
      ? openAiCompatibleStream({ ...request, onToken: (token) => tokens.push(token), onStreamEvent: (event) => events.push(event), onToolCallDelta: toolDelta })
      : openAiCompatibleComplete(request));
    const result = await run();
    expect(result.api).toBe("chat-completions");
    expect(result.reasoningBlock?.text).toBe("ACTUAL REASONING");
    expect(result.usage?.promptTokens).toBe(115_000);
    expect(calls.map((call) => [call.wire, call.real])).toEqual([["responses", false], ["chat", false], ["chat", true]]);
    for (const call of calls.slice(0, 2)) {
      expect(JSON.stringify(call.body).length).toBeLessThan(3000);
      expect(call.body.max_output_tokens ?? call.body.max_tokens ?? call.body.max_completion_tokens).toBe(512);
      expect(call.headers.get("authorization")).toBe("Bearer test-key");
      expect(call.headers.get("x-custom-route")).toBe("preferred");
      expect(call.headers.get("user-agent")).toBe("test-agent");
      expect(call.headers.get("x-clai-session")).toMatch(/^preflight-/);
      expect(Boolean(call.body.stream)).toBe(streaming);
    }
    expect(calls[1]!.body.reasoning_effort).toEqual(calls[2]!.body.reasoning_effort);
    expect(calls[1]!.body.temperature).toEqual(calls[2]!.body.temperature);
    expect(calls[2]!.headers.get("x-clai-session")).toBe("session-real");
    expect(tokens.join("")).toBe(streaming ? "REAL" : "");
    expect(JSON.stringify(events)).not.toContain("PROBE");
    expect(toolDelta).not.toHaveBeenCalled();
    const firstReal = JSON.stringify(calls[2]!.body);
    await run();
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls[3]!.body)).toBe(firstReal);
  });

  it.each([false, true])("keeps Responses with visible reasoning and never discards a later opaque result, streaming=%s", async (streaming) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push(String(url));
      const real = String(init.body).includes("PRIVATE HISTORY");
      return reply("responses", streaming, real ? "REAL" : "PROBE", real ? "" : "PROBE REASONING", real);
    }));
    const tokens: string[] = [];
    const run = () => streaming
      ? openAiCompatibleStream({ ...options, onToken: (token) => tokens.push(token) })
      : openAiCompatibleComplete(options);
    expect((await run()).api).toBe("responses");
    expect((await run()).text).toBe("REAL");
    expect(calls).toHaveLength(3);
    expect(calls.every((url) => url.endsWith("/responses"))).toBe(true);
    expect(tokens.join("")).toBe(streaming ? "REALREAL" : "");
  });

  it.each([false, true])("does not mistake private reasoning or missing text on both APIs for visible reasoning, streaming=%s", async (streaming) => {
    const wires: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      const wire = String(url).endsWith("/responses") ? "responses" : "chat";
      wires.push(wire);
      return reply(wire, streaming, String(init.body).includes("PRIVATE HISTORY") ? "REAL" : "PROBE", "", true);
    }));
    const result = streaming
      ? await openAiCompatibleStream({ ...options, onToken: vi.fn() })
      : await openAiCompatibleComplete(options);
    expect(result.api).toBe("responses");
    expect(wires).toEqual(["responses", "chat", "responses"]);
  });

  it("uses tiny tool schemas while preserving forced tool choice and the real schema", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return reply("responses", false, "REAL", "visible");
    }));
    const tools = [{ name: "fs.read", wireName: "fs_read", description: "PRIVATE TOOL DOCUMENTATION ".repeat(5000), parameters: { type: "object" as const, properties: { privateProperty: { type: "string" } } } }];
    await openAiCompatibleComplete({ ...options, tools, toolChoice: { type: "function", name: "fs.read" }, parallelToolCalls: false });
    expect(JSON.stringify(bodies[0]).length).toBeLessThan(3000);
    expect(bodies[0].tools[0].name).toBe(bodies[1].tools[0].name);
    expect(bodies[0].tool_choice).toEqual(bodies[1].tool_choice);
    expect(bodies[0].parallel_tool_calls).toBe(false);
    expect(JSON.stringify(bodies[0])).not.toContain("PRIVATE TOOL");
    expect(JSON.stringify(bodies[1])).toContain("PRIVATE TOOL");
  });

  it("does not raise a caller's smaller probe budget or cap the real generation", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      const wire = String(url).endsWith("/responses") ? "responses" : "chat";
      bodies.push(JSON.parse(String(init.body)));
      return reply(wire, false, "REAL", wire === "chat" ? "visible" : "");
    }));
    await openAiCompatibleComplete({ ...options, maxTokens: 128 });
    expect(bodies[0].max_output_tokens).toBe(128);
    expect(bodies[1].max_tokens).toBe(128);
    expect(bodies[2].max_tokens).toBeGreaterThan(128);
  });

  it.each([400, 500])("keeps a working Responses route when the optional Chat comparison fails with HTTP %s", async (status) => {
    const wires: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      const wire = String(url).endsWith("/responses") ? "responses" : "chat";
      wires.push(wire);
      return wire === "chat"
        ? json({ error: { message: "Chat unavailable" } }, status)
        : reply(wire, false, String(init.body).includes("PRIVATE HISTORY") ? "REAL" : "PROBE");
    }));
    expect((await openAiCompatibleComplete(options)).api).toBe("responses");
    expect(wires).toEqual(["responses", "chat", "responses"]);
  });

  it("negotiates optional extras on small requests, then admits only the real generation", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if (body.include) return json({ error: { message: "Unknown parameter include" } }, 400);
      return reply("responses", false, String(init.body).includes("PRIVATE HISTORY") ? "REAL" : "PROBE", "visible");
    }));
    const recorder = new OperationUsageRecorder();
    const result = await runGenerationAttempt({ messages: options.messages, attemptUsage: recorder }, {
      provider: options.providerId, model: options.model, mode: "complete", reason: "initial",
    }, async () => ({ ...await openAiCompatibleComplete(options), provider: options.providerId, model: options.model }));
    expect(calls).toHaveLength(3);
    expect(calls.slice(0, 2).every((body) => !JSON.stringify(body).includes("PRIVATE HISTORY"))).toBe(true);
    expect(calls[2].include).toBeUndefined();
    expect(recorder.snapshot().attempts).toHaveLength(1);
    expect(recorder.snapshot().aggregate.usage?.promptTokens).toBe(115_000);
    expect(result.usage?.promptTokens).toBe(115_000);
  });

  it.each([401, 403, 429, 500, 503])("does not cache transient/auth failure HTTP %s as unsupported", async (status) => {
    let failing = true;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push(String(url));
      return failing ? json({ error: { message: "Unavailable" } }, status) : reply("responses", false, String(init.body).includes("PRIVATE HISTORY") ? "REAL" : "PROBE", "visible");
    }));
    await expect(openAiCompatibleComplete(options)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    failing = false;
    expect((await openAiCompatibleComplete(options)).api).toBe("responses");
    expect(calls).toHaveLength(3);
    expect(calls.every((url) => url.endsWith("/responses"))).toBe(true);
  });

  it("falls back to chat when the probe times out instead of failing the request", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => {
      calls += 1;
      const wire = String(url).endsWith("/responses") ? "responses" : "chat";
      if (wire === "responses" && !String(init.body).includes("PRIVATE HISTORY")) {
        throw new DOMException("Capability preflight timed out", "TimeoutError");
      }
      return reply(wire, false, String(init.body).includes("PRIVATE HISTORY") ? "REAL" : "PROBE", wire === "chat" ? "visible" : "");
    }));
    const result = await openAiCompatibleComplete(options);
    expect(result.api).toBe("chat-completions");
    expect(result.text).toBe("REAL");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("route selection cache and cancellation", () => {
  const selected: ResponsesSelection = { wire: "responses", extras: "full" };

  it("shares one negotiation while keeping waiter cancellation independent", async () => {
    let resolve!: (selection: ResponsesSelection) => void;
    let probeSignal!: AbortSignal;
    const probe = vi.fn((signal: AbortSignal) => {
      probeSignal = signal;
      return new Promise<ResponsesSelection>((done) => { resolve = done; });
    });
    const controller = new AbortController();
    const first = selectResponsesWire({ ...options, signal: controller.signal }, true, probe);
    const second = selectResponsesWire(options, true, probe);
    const assertion = expect(first).rejects.toThrow();
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(probeSignal.aborted).toBe(false);
    resolve(selected);
    expect(await second).toEqual(selected);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("cancels abandoned probes without poisoning a subsequent attempt", async () => {
    const controller = new AbortController();
    let probeSignal!: AbortSignal;
    const first = selectResponsesWire({ ...options, signal: controller.signal }, false, (signal) => {
      probeSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const assertion = expect(first).rejects.toThrow();
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(probeSignal.aborted).toBe(true);
    const probe = vi.fn(async () => selected);
    expect(await selectResponsesWire(options, false, probe)).toEqual(selected);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("does not start a probe for an already cancelled caller", async () => {
    const probe = vi.fn(async () => selected);
    await expect(selectResponsesWire({ ...options, signal: AbortSignal.abort() }, false, probe)).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    { baseUrl: "https://other.test/v1" },
    { apiKey: "different-key" },
    { headers: { "x-custom-route": "other" } },
    { reasoning: { enabled: true, effort: "low" as const } },
    { model: "different-model" },
    { temperature: 0.1 },
    { parallelToolCalls: false },
    { includeStreamUsage: false },
  ])("isolates changed route/options %j", async (change) => {
    const probe = vi.fn(async () => selected);
    await selectResponsesWire(options, false, probe);
    await selectResponsesWire({ ...options, ...change }, false, probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("separates streaming support but reuses negotiation across histories and output sizes", async () => {
    const probe = vi.fn(async () => selected);
    await selectResponsesWire(options, false, probe);
    await selectResponsesWire({ ...options, messages: [], maxTokens: 32_000 }, false, probe);
    expect(probe).toHaveBeenCalledOnce();
    await selectResponsesWire(options, true, probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("expires route observations for new sessions without changing an active session's wire", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => selected);
    await withSessionAffinity("first", () => selectResponsesWire(options, false, probe));
    await withSessionAffinity("second", () => selectResponsesWire(options, false, probe));
    expect(probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    await withSessionAffinity("first", () => selectResponsesWire(options, false, probe));
    expect(probe).toHaveBeenCalledOnce();
    await withSessionAffinity("third", () => selectResponsesWire(options, false, probe));
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
