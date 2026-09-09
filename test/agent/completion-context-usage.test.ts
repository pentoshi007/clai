import { describe, expect, it, vi } from "vitest";
import { accountCompletionUsage } from "../../src/agent/turn/loop/completion-interpretation.js";
import type { CompletionResult } from "../../src/types.js";

function ports() {
  return {
    dispatchedRawRequestTokens: 1_000,
    dispatchedRequestRoute: { provider: "agentrouter" as const, model: "test-model" },
    emitTokenUsage: vi.fn(),
    emitContextFallback: vi.fn(),
    audit: vi.fn().mockResolvedValue(undefined),
  };
}

const response: CompletionResult = {
  provider: "agentrouter",
  model: "test-model",
  text: "Hello",
};

describe("completed request context accounting", () => {
  it("uses a fallback after a response without usage rather than inventing reported tokens", async () => {
    const handlers = ports();
    await accountCompletionUsage(handlers, response);
    expect(handlers.emitTokenUsage).not.toHaveBeenCalled();
    expect(handlers.emitContextFallback).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
  });

  it("preserves exact output-only telemetry before falling back for context", async () => {
    const handlers = ports();
    const usage = {
      promptTokens: 0,
      promptTokensKnown: false as const,
      completionTokens: 12,
      totalTokens: 12,
      exact: true,
    };
    await accountCompletionUsage(handlers, { ...response, usage });
    expect(handlers.emitTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ usage }));
    expect(handlers.emitContextFallback).toHaveBeenCalledOnce();
    expect(handlers.emitTokenUsage.mock.invocationCallOrder[0]).toBeLessThan(
      handlers.emitContextFallback.mock.invocationCallOrder[0]!,
    );
  });

  it.each([0, 115_000, 147_000])("prioritizes the reported %i tokens without forcing monotonic counts", async (promptTokens) => {
    const handlers = ports();
    await accountCompletionUsage(handlers, {
      ...response,
      usage: { promptTokens, completionTokens: 12, totalTokens: promptTokens + 12, exact: true },
    });
    expect(handlers.emitContextFallback).not.toHaveBeenCalled();
    expect(handlers.emitTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ promptTokens }),
    }));
  });
});
