import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../../src/types.js";
import { geminiProvider } from "../../src/llm/gemini.js";
import { GenerationProgressTracker } from "../../src/llm/generation-progress.js";
import { openAiCompatibleStream } from "../../src/llm/http.js";
import type { LlmProvider } from "../../src/llm/provider.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";

let now = 0;
const trackers: GenerationProgressTracker[] = [];
const usage = { promptTokens: 1_000, completionTokens: 20, totalTokens: 1_020, exact: true };

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function tracker(signal?: AbortSignal) {
  const publish = vi.fn();
  const progress = new GenerationProgressTracker(publish, 0, signal);
  trackers.push(progress);
  return { progress, publish };
}

describe("live throughput regressions", () => {
  it("updates the elapsed time during a provider pause instead of freezing a fast burst", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { progress, publish } = tracker();
    now = 1_000;
    progress.observe({ type: "answer_delta", text: "x".repeat(330) });
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 100, durationMs: 1_000, estimated: true });
    now = 10_000;
    vi.advanceTimersByTime(9_000);
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 100, durationMs: 10_000, estimated: true });
  });

  it.each(["close", "abort", "reset"] as const)("stops stale sampling on %s", (settle) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const controller = new AbortController();
    const { progress, publish } = tracker(controller.signal);
    now = 1_000;
    progress.observe({ type: "answer_delta", text: "x".repeat(330) });
    expect(vi.getTimerCount()).toBe(1);
    if (settle === "close") progress.close();
    if (settle === "abort") controller.abort();
    if (settle === "reset") progress.reset(1_000);
    const calls = publish.mock.calls.length;
    now = 5_000;
    vi.advanceTimersByTime(4_000);
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
    if (settle === "reset") {
      now = 6_000;
      progress.observe({ type: "answer_delta", text: "x".repeat(33) });
      expect(publish).toHaveBeenLastCalledWith({ outputTokens: 10, durationMs: 5_000, estimated: true });
      expect(vi.getTimerCount()).toBe(1);
    }
  });

  it("does not schedule sampling before output or for an already-aborted request", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const controller = new AbortController();
    controller.abort();
    const active = tracker();
    const cancelled = tracker(controller.signal);
    now = 1_000;
    active.progress.observe({ type: "answer_delta", text: "" });
    cancelled.progress.observe({ type: "answer_delta", text: "x".repeat(330) });
    expect(vi.getTimerCount()).toBe(0);
    expect(active.publish).not.toHaveBeenCalled();
    expect(cancelled.publish).not.toHaveBeenCalled();
  });

  it("immediately replaces an estimate with exact usage inside the update throttle", () => {
    const { progress, publish } = tracker();
    now = 1_000;
    progress.observe({ type: "answer_delta", text: "x".repeat(330) });
    now = 1_010;
    progress.observeUsage(usage);
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 20, durationMs: 1_010 });
  });

  it("throttles frequent exact counters without losing the latest measurement", () => {
    const { progress, publish } = tracker();
    for (now = 1; now <= 1_000; now++) progress.observeUsage({ ...usage, completionTokens: now });
    expect(publish).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 1_000, durationMs: 1_000 });
  });

  it("counts reasoning and tool output when progress is the only stream observer", async () => {
    const publish = vi.fn();
    const provider: LlmProvider = {
      id: "openai", displayName: "fixture", defaultModel: "fixture", validateKey: () => true,
      async ping() {},
      async complete() { return { provider: "openai", model: "fixture", text: "done" }; },
      async stream(request, _auth, onToken) {
        now = 1_000;
        request.onStreamEvent?.({ type: "reasoning_delta", text: "x".repeat(99) });
        expect(publish).toHaveBeenLastCalledWith({ outputTokens: 30, durationMs: 1_000, estimated: true });
        now = 1_250;
        request.onToolCallDelta?.({ index: 0, name: "run", argumentsBytes: 66 });
        now = 1_500;
        onToken("x".repeat(33));
        return { provider: "openai", model: "fixture", text: "done" };
      },
    };
    await tryStreamOnce(provider, "openai", { messages: [], onGenerationProgress: publish }, "fixture", {}, () => {}, undefined, "initial");
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 61, durationMs: 1_500, estimated: true });
  });
});

const chatProvider: LlmProvider = {
  id: "openai", displayName: "fixture", defaultModel: "fixture", validateKey: () => true,
  async ping() {},
  async complete() { return { provider: "openai", model: "fixture", text: "done" }; },
  async stream(request, _auth, onToken) {
    const result = await openAiCompatibleStream({
      provider: "fixture", providerId: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture",
      model: "fixture", messages: request.messages, onToken, wireApi: "chat-completions",
      onStreamEvent: request.onStreamEvent, onToolCallDelta: request.onToolCallDelta,
    });
    return { ...result, provider: "openai", model: "fixture" };
  },
};

function frame(at: number, payload: Record<string, unknown>) {
  return { at, data: `data: ${JSON.stringify(payload)}\n\n` };
}

it.each(["openai", "gemini"] as const)("does not count %s output twice when usage and text share a frame", async (family) => {
  const frames = family === "openai" ? [
    frame(1_000, { choices: [{ delta: { content: "x".repeat(99) } }], usage: { completion_tokens: 30 } }),
    frame(1_250, { choices: [{ delta: { content: "x".repeat(33) } }] }),
    frame(1_500, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 40 } }),
  ] : [
    frame(1_000, { candidates: [{ content: { parts: [{ text: "x".repeat(99) }] } }], usageMetadata: { candidatesTokenCount: 30 } }),
    frame(1_250, { candidates: [{ content: { parts: [{ text: "x".repeat(33) }] } }] }),
    frame(1_500, { candidates: [{ finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 40 } }),
  ];
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = frames.shift();
      if (!next) { controller.close(); return; }
      now = next.at;
      controller.enqueue(encoder.encode(next.data));
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })));
  const publish = vi.fn();
  const request: CompletionRequest = { provider: family, model: "fixture", messages: [], onStreamEvent() {}, onGenerationProgress: publish };
  const completion = await tryStreamOnce(family === "openai" ? chatProvider : geminiProvider, family, request, "fixture", { apiKey: "fixture" }, () => {}, undefined, "initial");
  expect(publish.mock.calls.find(([metrics]) => metrics.durationMs === 1_250)?.[0])
    .toEqual({ outputTokens: 40, durationMs: 1_250, estimated: true });
  expect(completion.usage?.completionTokens).toBe(40);
  expect(completion.generationDurationMs).toBe(1_500);
});
