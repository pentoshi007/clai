import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionResult, GenerationAttemptInput, TokenUsage } from "../../src/types.js";
import type { LlmProvider } from "../../src/llm/provider.js";
import { GenerationProgressTracker } from "../../src/llm/generation-progress.js";
import {
  generationFetch, observeGenerationStreamEvent, observeStreamUsage,
  runGenerationAttempt, withUnrecordedTransport,
} from "../../src/llm/operation-usage.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";

let now = 0;
const trackers: GenerationProgressTracker[] = [];
const usage: TokenUsage = { promptTokens: 1_000, completionTokens: 100, reasoningTokens: 60, totalTokens: 1_100, exact: true };
const result: CompletionResult = { provider: "openai", model: "fixture", text: "done", usage };
const attempt: GenerationAttemptInput = { provider: "openai", model: "fixture", mode: "stream", reason: "initial" };

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  for (const progress of trackers.splice(0)) progress.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function tracker(signal?: AbortSignal) {
  const publish = vi.fn();
  const progress = new GenerationProgressTracker(publish, 0, signal);
  trackers.push(progress);
  return { progress, publish };
}

describe("live generation throughput", () => {
  it("estimates output consistently regardless of transport chunk boundaries", () => {
    const single = tracker();
    const split = tracker();
    single.progress.observe({ type: "answer_delta", text: "x".repeat(99) });
    for (let i = 0; i < 3; i++) split.progress.observe({ type: "answer_delta", text: "x".repeat(33) });
    expect(single.publish).not.toHaveBeenCalled();
    now = 1_000;
    for (const { progress } of [single, split]) progress.observe({ type: "answer_delta", text: "x".repeat(33) });
    expect(single.publish).toHaveBeenCalledExactlyOnceWith({ outputTokens: 40, durationMs: 1_000, estimated: true });
    expect(split.publish.mock.calls).toEqual(single.publish.mock.calls);
  });

  it("includes reasoning, commentary, answer, and each tool's incremental arguments once", () => {
    const { progress, publish } = tracker();
    progress.observe({ type: "reasoning_delta", text: "x".repeat(33) });
    progress.observe({ type: "commentary_delta", text: "x".repeat(33) });
    progress.observe({ type: "answer_delta", text: "x".repeat(33) });
    for (const index of [0, 1]) {
      progress.observe({ type: "tool_call_started", index, name: "run" });
      const argumentsBytes = index === 0 ? 66 : 33;
      progress.observe({ type: "tool_arguments_delta", index, argumentsBytes });
      progress.observe({ type: "tool_arguments_delta", index, argumentsBytes });
      progress.observe({ type: "tool_call_completed", index, name: "run" });
    }
    now = 1_000;
    progress.observe({ type: "answer_delta", text: "x".repeat(27) });
    expect(publish).toHaveBeenCalledExactlyOnceWith({ outputTokens: 70, durationMs: 1_000, estimated: true });
    now = 2_000;
    progress.observe({ type: "tool_call_completed", index: 0, name: "run" });
    progress.observe({ type: "tool_arguments_delta", index: 0, argumentsBytes: 65 });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("throttles high-rate output and freezes the reading after settlement", () => {
    const { progress, publish } = tracker();
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    for (now = 1; now <= 1_000; now++) progress.observe({ type: "answer_delta", text: "x" });
    expect(publish).toHaveBeenCalledTimes(4);
    expect(publish.mock.calls.at(-1)?.[0]).toEqual({ outputTokens: 304, durationMs: 1_000, estimated: true });
    progress.close();
    now = 60_000;
    expect(publish).toHaveBeenCalledTimes(4);
    expect(interval).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled();
  });

  it("uses exact provider counters when available and does not double-count reasoning or input", () => {
    const { progress, publish } = tracker();
    now = 1_000;
    progress.observe({ type: "reasoning_delta", text: "x".repeat(33) });
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 10, durationMs: 1_000, estimated: true });
    now = 2_000;
    progress.observeUsage(usage);
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 100, durationMs: 2_000 });
    now = 2_500;
    progress.observe({ type: "answer_delta", text: "x".repeat(33) });
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 110, durationMs: 2_500, estimated: true });
    now = 3_000;
    progress.observe({ type: "usage_observed", usage: { ...usage, completionTokens: 120 } });
    expect(publish).toHaveBeenLastCalledWith({ outputTokens: 120, durationMs: 3_000 });
  });

  it("does not treat unknown usage, empty deltas, artifacts, or protocol metadata as tokens", () => {
    const { progress, publish } = tracker();
    now = 1_000;
    for (const completionTokens of [0, -1, NaN, Infinity, 1.5]) progress.observeUsage({ ...usage, completionTokens });
    progress.observeUsage({ ...usage, exact: false });
    progress.observeUsage(undefined);
    progress.observe({ type: "answer_delta", text: "" });
    progress.observe({ type: "reasoning_artifact_available", artifacts: [] });
    progress.observe({ type: "provider_terminal" });
    progress.observe({ type: "tool_arguments_delta", index: 0, argumentsBytes: Infinity });
    expect(publish).not.toHaveBeenCalled();
  });

  it("stops publishing immediately on cancellation and after settlement", () => {
    const controller = new AbortController();
    const cancelled = tracker(controller.signal);
    const settled = tracker();
    controller.abort();
    settled.progress.close();
    now = 1_000;
    for (const { progress, publish } of [cancelled, settled]) {
      progress.observe({ type: "answer_delta", text: "x".repeat(99) });
      progress.observeUsage(usage);
      expect(publish).not.toHaveBeenCalled();
    }
  });
});

describe("generation progress integration", () => {
  it("publishes before the real provider stream resolves while preserving its event contract", async () => {
    const publish = vi.fn();
    const downstream = vi.fn();
    let finish: (() => void) | undefined;
    const provider: LlmProvider = {
      id: "openai", displayName: "fixture", defaultModel: "fixture", validateKey: () => true,
      async ping() {}, async complete() { return result; },
      async stream(request, _auth, onToken) {
        now = 1_000;
        onToken("x".repeat(99));
        expect(publish).toHaveBeenLastCalledWith({ outputTokens: 30, durationMs: 1_000, estimated: true });
        now = 2_000;
        request.onStreamEvent?.({ type: "reasoning_delta", text: "x".repeat(33) });
        expect(publish).toHaveBeenLastCalledWith({ outputTokens: 40, durationMs: 2_000, estimated: true });
        now = 3_000;
        observeStreamUsage(usage);
        expect(publish).toHaveBeenLastCalledWith({ outputTokens: 100, durationMs: 3_000 });
        await new Promise<void>((resolve) => { finish = resolve; });
        return result;
      },
    };
    const pending = tryStreamOnce(provider, "openai", {
      provider: "openai", model: "fixture", messages: [], onStreamEvent: downstream, onGenerationProgress: publish,
    }, "fixture", {}, () => {}, undefined, "initial");
    await expect.poll(() => finish).toBeDefined();
    expect(publish).toHaveBeenCalledTimes(3);
    expect(downstream.mock.calls.map(([event]) => event.type)).toEqual(["answer_delta", "reasoning_delta"]);
    finish?.();
    expect((await pending).generationDurationMs).toBe(3_000);
    expect(downstream.mock.calls.map(([event]) => event.type)).toEqual(["answer_delta", "reasoning_delta", "usage_observed", "provider_terminal"]);
  });

  it("resets live counters and the clock at actual dispatch, excluding setup, failed attempts, and backoff", async () => {
    const publish = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("retry", { status: 503 })).mockResolvedValueOnce(new Response("ok")));
    await runGenerationAttempt({ messages: [], onGenerationProgress: publish }, attempt, async () => {
      now = 1_000;
      await generationFetch("https://fixture.invalid/generate");
      observeStreamUsage({ ...usage, completionTokens: 999 });
      now = 5_000;
      await generationFetch("https://fixture.invalid/generate");
      now = 6_000;
      observeGenerationStreamEvent({ type: "answer_delta", text: "x".repeat(99) });
      return result;
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith({ outputTokens: 30, durationMs: 1_000, estimated: true });
  });

  it("does not leak probe or auxiliary usage into the main generation", async () => {
    const publish = vi.fn();
    await runGenerationAttempt({ messages: [], onGenerationProgress: publish }, attempt, async () => {
      await withUnrecordedTransport(async () => {
        now = 1_000;
        observeGenerationStreamEvent({ type: "answer_delta", text: "x".repeat(999) });
        observeStreamUsage(usage);
      });
      for (const purpose of ["compaction", "auxiliary"] as const) {
        await runGenerationAttempt({ messages: [], purpose, onGenerationProgress: publish }, attempt, async () => {
          now += 1_000;
          observeGenerationStreamEvent({ type: "answer_delta", text: "x".repeat(999) });
          observeStreamUsage(usage);
          return result;
        });
      }
      expect(publish).not.toHaveBeenCalled();
      now = 4_000;
      observeGenerationStreamEvent({ type: "answer_delta", text: "x".repeat(33) });
      return result;
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith({ outputTokens: 10, durationMs: 4_000, estimated: true });
  });

  it("isolates concurrent streams and closes inherited async contexts after settlement", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const late: (() => void)[] = [];
    await Promise.all([first, second].map((publish, index) => runGenerationAttempt({ messages: [], onGenerationProgress: publish }, attempt, async () => {
      await Promise.resolve();
      now = 1_000;
      observeGenerationStreamEvent({ type: "answer_delta", text: "x".repeat(33 * (index + 1)) });
      const runInScope = AsyncLocalStorage.snapshot();
      late.push(() => runInScope(() => observeStreamUsage(usage)));
      return result;
    })));
    expect(first).toHaveBeenCalledExactlyOnceWith({ outputTokens: 10, durationMs: 1_000, estimated: true });
    expect(second).toHaveBeenCalledExactlyOnceWith({ outputTokens: 20, durationMs: 1_000, estimated: true });
    now = 2_000;
    for (const emit of late) emit();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
