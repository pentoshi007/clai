import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletionResult, GenerationAttemptInput } from "../../src/types.js";
import {
  addGenerationMetrics,
  completionGenerationMetrics,
  generationTokensPerSecond,
  interruptedGenerationMetrics,
  recordInterruptedGeneration,
  validGenerationMetrics,
} from "../../src/llm/generation-metrics.js";
import { generationFetch, observeStreamUsage, OperationUsageRecorder, runGenerationAttempt } from "../../src/llm/operation-usage.js";
import { parseGeminiUsage, parseOpenAiUsage } from "../../src/llm/token-usage.js";

const attempt: GenerationAttemptInput = { provider: "openai", model: "fixture", mode: "stream", reason: "initial" };
const result: CompletionResult = {
  provider: "openai", model: "fixture", text: "done", generationDurationMs: 2_000,
  usage: { promptTokens: 1_000, completionTokens: 100, reasoningTokens: 60, totalTokens: 1_100, exact: true },
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("generation throughput", () => {
  it("weights all steps by provider-active duration instead of averaging their rates", () => {
    const first = completionGenerationMetrics(result);
    const total = addGenerationMetrics(first, { outputTokens: 300, durationMs: 10_000 });
    expect(total).toEqual({ outputTokens: 400, durationMs: 12_000 });
    expect(generationTokensPerSecond(total ?? undefined)).toBeCloseTo(33.333333);
  });

  it("counts reasoning once for both inclusive OpenAI and split Gemini wire counters", () => {
    const usages = [
      parseOpenAiUsage({ prompt_tokens: 1_000, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 60 } }),
      parseGeminiUsage({ promptTokenCount: 1_000, candidatesTokenCount: 40, thoughtsTokenCount: 60 }),
    ];
    for (const usage of usages) {
      const metrics = completionGenerationMetrics({ ...result, usage });
      expect(metrics).toEqual({ outputTokens: 100, durationMs: 2_000 });
      expect(generationTokensPerSecond(metrics)).toBe(50);
    }
  });

  it("does not substitute estimates, characters, or input/cache tokens for output", () => {
    expect(completionGenerationMetrics({ ...result, usage: undefined })).toBeUndefined();
    expect(completionGenerationMetrics({ ...result, usage: { ...result.usage!, exact: false } })).toBeUndefined();
    expect(completionGenerationMetrics({ ...result, generationDurationMs: undefined })).toBeUndefined();
    expect(completionGenerationMetrics({ ...result, usage: { ...result.usage!, completionTokens: NaN } })).toBeUndefined();
  });

  it.each([
    undefined, null, {}, { outputTokens: "100", durationMs: 1_000 },
    { outputTokens: -1, durationMs: 1_000 }, { outputTokens: 1.5, durationMs: 1_000 },
    { outputTokens: Infinity, durationMs: 1_000 }, { outputTokens: 1, durationMs: 0 },
    { outputTokens: 1, durationMs: -1 }, { outputTokens: 1, durationMs: NaN },
    { outputTokens: 1, durationMs: Infinity },
  ])("rejects invalid metrics: %j", (metrics) => {
    expect(validGenerationMetrics(metrics)).toBe(false);
  });

  it("retains zero-output step durations but hides a turn with no output", () => {
    const empty = { outputTokens: 0, durationMs: 1_000 };
    expect(validGenerationMetrics(empty)).toBe(true);
    expect(generationTokensPerSecond(empty)).toBeUndefined();
    const total = addGenerationMetrics(empty, { outputTokens: 100, durationMs: 1_000 });
    expect(generationTokensPerSecond(total ?? undefined)).toBe(50);
  });

  it("hides incomplete totals permanently for that turn and rejects arithmetic overflow", () => {
    const metrics = { outputTokens: 100, durationMs: 1_000 };
    const incomplete = addGenerationMetrics(metrics, undefined);
    expect(incomplete).toBeNull();
    expect(addGenerationMetrics(incomplete, metrics)).toBeNull();
    expect(addGenerationMetrics(undefined, undefined)).toBeNull();
    expect(addGenerationMetrics({ outputTokens: Number.MAX_SAFE_INTEGER, durationMs: 1 }, metrics)).toBeNull();
    expect(generationTokensPerSecond({ outputTokens: 1, durationMs: Number.MIN_VALUE })).toBeUndefined();
  });
});

describe("provider-active timing", () => {
  it.each([true, false])("measures dispatch through final usage with recording=%s", async (recording) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", vi.fn(async () => { now = 1_200; return new Response("ok"); }));
    const recorder = new OperationUsageRecorder();
    const completion = await runGenerationAttempt({ messages: [], ...(recording ? { attemptUsage: recorder } : {}) }, attempt, async () => {
      now = 1_000;
      const response = await generationFetch("https://fixture.invalid/generate");
      await response.text();
      now = 3_000;
      return { ...result, generationDurationMs: undefined };
    });
    expect(completion.generationDurationMs).toBe(2_000);
    expect(completionGenerationMetrics(completion)).toEqual({ outputTokens: 100, durationMs: 2_000 });
    if (recording) expect(recorder.snapshot().attempts).toMatchObject([{ outcome: "success", usage: { kind: "known" } }]);
  });

  it("excludes failed requests and internal retry backoff from the successful dispatch", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("retry", { status: 503 })).mockResolvedValueOnce(new Response("ok")));
    const recorder = new OperationUsageRecorder();
    const completion = await runGenerationAttempt({ messages: [], attemptUsage: recorder }, attempt, async () => {
      await generationFetch("https://fixture.invalid/generate");
      now = 5_000;
      await generationFetch("https://fixture.invalid/generate");
      now = 6_000;
      return { ...result, generationDurationMs: undefined };
    });
    expect(completion.generationDurationMs).toBe(1_000);
    expect(recorder.snapshot().attempts.map((entry) => entry.outcome)).toEqual(["failure", "success"]);
  });

  it("preserves an inner provider's measured span through nested wrappers", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(10_000);
    const completion = await runGenerationAttempt({ messages: [] }, attempt, async () => result);
    expect(completion.generationDurationMs).toBe(2_000);
  });

  it("keeps failures as failures without manufacturing completion metrics", async () => {
    const error = new Error("interrupted");
    await expect(runGenerationAttempt({ messages: [] }, attempt, async () => { throw error; })).rejects.toBe(error);
  });
});

describe("interrupted generation measurements", () => {
  it("retains exact observed output and the provider-active span without changing the abort error", async () => {
    const controller = new AbortController();
    const error = new DOMException("cancelled", "AbortError");
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValue(4_000);
    await expect(runGenerationAttempt({ messages: [], signal: controller.signal }, attempt, async () => {
      observeStreamUsage(result.usage);
      controller.abort();
      throw error;
    })).rejects.toBe(error);
    expect(interruptedGenerationMetrics(error)).toEqual({ outputTokens: 100, durationMs: 3_000 });
  });

  it.each([undefined, { ...result.usage!, exact: false }])("does not invent partial output counters from %j", async (usage) => {
    const controller = new AbortController();
    const error = new DOMException("cancelled", "AbortError");
    await expect(runGenerationAttempt({ messages: [], signal: controller.signal }, attempt, async () => {
      observeStreamUsage(usage);
      controller.abort();
      throw error;
    })).rejects.toBe(error);
    expect(interruptedGenerationMetrics(error)).toBeUndefined();
  });

  it("preserves inner measurements through frozen errors and cause wrappers", () => {
    const error = Object.freeze(new DOMException("cancelled", "AbortError"));
    recordInterruptedGeneration(error, result.usage, 2_000);
    recordInterruptedGeneration(error, result.usage, 10_000);
    expect(interruptedGenerationMetrics(new Error("wrapped", { cause: error })))
      .toEqual({ outputTokens: 100, durationMs: 2_000 });
    const cycle = new Error("cycle");
    Object.defineProperty(cycle, "cause", { value: cycle });
    expect(interruptedGenerationMetrics(cycle)).toBeUndefined();
    expect(interruptedGenerationMetrics("cancelled")).toBeUndefined();
  });
});
