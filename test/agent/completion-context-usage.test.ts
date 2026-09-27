import { describe, expect, it, vi } from "vitest";
import { accountCompletionUsage } from "../../src/agent/turn/loop/completion-interpretation.js";
import type { CompletionResult } from "../../src/types.js";

function ports() {
  return {
    dispatchedRawRequestTokens: 1_000,
    dispatchedRequestRoute: { provider: "agentrouter" as const, model: "test-model" },
    emitTokenUsage: vi.fn(),
    audit: vi.fn().mockResolvedValue(undefined),
  };
}

const response: CompletionResult = {
  provider: "agentrouter",
  model: "test-model",
  text: "Hello",
};

describe("completed request context accounting", () => {
  it("reports nothing after a response without usage rather than inventing tokens", async () => {
    const handlers = ports();
    await accountCompletionUsage(handlers, response);
    expect(handlers.emitTokenUsage).not.toHaveBeenCalled();
  });

  it("forwards exact output-only telemetry without an estimated prompt size", async () => {
    const handlers = ports();
    const usage = {
      promptTokens: 0,
      promptTokensKnown: false as const,
      completionTokens: 12,
      totalTokens: 12,
      exact: true,
    };
    await accountCompletionUsage(handlers, { ...response, usage });
    expect(handlers.emitTokenUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage }));
  });

  it.each([0, 115_000, 147_000])("prioritizes the reported %i tokens without forcing monotonic counts", async (promptTokens) => {
    const handlers = ports();
    await accountCompletionUsage(handlers, {
      ...response,
      usage: { promptTokens, completionTokens: 12, totalTokens: promptTokens + 12, exact: true },
    });
    expect(handlers.emitTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ promptTokens }),
    }));
  });
});
