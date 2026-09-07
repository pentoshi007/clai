import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "../src/types.js";
import type { ProviderAuth } from "../src/llm/provider.js";
import { ProviderError } from "../src/llm/http.js";
import {
  isServerErrorFailure,
  markServerErrorAttempts,
  SERVER_ERROR_MAX_ATTEMPTS,
  serverErrorAttemptsFor,
} from "../src/llm/routing/error-classification.js";
import { aggregateProviderError } from "../src/llm/routing/failure-report.js";

const nvidiaComplete = vi.fn();

vi.mock("../src/llm/nvidia.js", () => ({
  nvidiaProvider: {
    id: "nvidia",
    displayName: "NVIDIA",
    defaultModel: "moonshotai/Kimi-K2.6",
    validateKey: () => true,
    ping: async () => undefined,
    complete: (request: CompletionRequest, auth: ProviderAuth) =>
      nvidiaComplete(request, auth) as Promise<CompletionResult>,
  },
}));

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) =>
      provider === "nvidia"
        ? {
            keys: [{ id: "k1", value: "nvapi-single", createdAt: 0 }],
            activeIndex: 0,
            source: "fallback",
          }
        : { keys: [], activeIndex: 0, source: "missing" },
    getProviderSecret: async () => ({
      value: "nvapi-single",
      source: "fallback" as const,
    }),
    markProviderKeySuccess: async () => undefined,
  };
});

vi.mock("../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      defaultProvider: "nvidia",
      defaultModel: "moonshotai/Kimi-K2.6",
      providerFallback: true,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
    providerUsesEndpoints: () => false,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
  };
});

function request(): CompletionRequest {
  return {
    provider: "nvidia",
    model: "moonshotai/Kimi-K2.6",
    messages: [{ role: "user", content: "hello" }],
  };
}

describe("server error attempt budget helpers", () => {
  it("detects 5xx provider errors as server failures", () => {
    expect(isServerErrorFailure(new ProviderError("boom", 500))).toBe(true);
    expect(isServerErrorFailure(new ProviderError("boom", 599))).toBe(true);
    expect(isServerErrorFailure(new ProviderError("rl", 429))).toBe(false);
    expect(isServerErrorFailure(new Error("boom"))).toBe(false);
  });

  it("round-trips tagged attempt counts", () => {
    const error = new ProviderError("boom", 500);
    expect(serverErrorAttemptsFor(error)).toBe(0);
    markServerErrorAttempts(error, 3);
    expect(serverErrorAttemptsFor(error)).toBe(3);
    markServerErrorAttempts(error, 4);
    expect(serverErrorAttemptsFor(error)).toBe(4);
    expect(serverErrorAttemptsFor(undefined)).toBe(0);
    expect(serverErrorAttemptsFor("boom")).toBe(0);
  });

  it("propagates the max tagged count through aggregateProviderError", () => {
    const first = markServerErrorAttempts(new ProviderError("a", 500), 2);
    const second = markServerErrorAttempts(new ProviderError("b", 503), 4);
    const aggregate = aggregateProviderError("No provider could complete.", [
      { provider: "nvidia", message: "a", error: first },
      { provider: "hetzner", message: "b", error: second },
    ]);
    expect(serverErrorAttemptsFor(aggregate)).toBe(4);
  });
});

describe("persistent server error budget", () => {
  beforeEach(() => {
    nvidiaComplete.mockReset();
    nvidiaComplete.mockRejectedValue(new ProviderError("upstream 500", 500));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops after SERVER_ERROR_MAX_ATTEMPTS and fails", async () => {
    const { completeWithProvider } = await import("../src/llm/router.js");
    const outcome = completeWithProvider(request()).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await outcome;
    expect(nvidiaComplete).toHaveBeenCalledTimes(SERVER_ERROR_MAX_ATTEMPTS);
    expect(error).toBeInstanceOf(ProviderError);
    expect(serverErrorAttemptsFor(error)).toBe(SERVER_ERROR_MAX_ATTEMPTS);
  });

  it("still succeeds when a retry recovers before the budget", async () => {
    nvidiaComplete
      .mockRejectedValueOnce(new ProviderError("upstream 500", 500))
      .mockRejectedValueOnce(new ProviderError("upstream 500", 500))
      .mockResolvedValueOnce({
        text: "ok",
        provider: "nvidia",
        model: "moonshotai/Kimi-K2.6",
        finishReason: "stop",
      } as CompletionResult);
    const { completeWithProvider } = await import("../src/llm/router.js");
    const outcome = completeWithProvider(request());
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    expect(result.text).toBe("ok");
    expect(nvidiaComplete).toHaveBeenCalledTimes(3);
  });
});
