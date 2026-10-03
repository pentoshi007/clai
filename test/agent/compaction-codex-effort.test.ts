import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";
import { codexConfigFor } from "../../src/llm/codex-config.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import { resetReasoningKnowledge } from "../../src/llm/capabilities.js";

const { complete, stream } = vi.hoisted(() => ({ complete: vi.fn(), stream: vi.fn() }));
vi.mock("../../src/llm/router.js", () => ({ completeWithProvider: complete, streamWithProvider: stream }));
vi.mock("../../src/llm/context-windows.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/llm/context-windows.js")>(),
  modelMaxOutputTokens: () => 4096,
}));
const { executeCompactionSummary } = await import("../../src/agent/compaction-executor.js");
const model = "gpt-6.1-sol";
const summary: CompletionResult = {
  provider: "codex", model, finishReason: "stop",
  text: "## Work completed\nThe request and provider transport were inspected.\n\n## Remaining work\nRun the regression suite and retain the selected effort.",
};

function execution(streaming: boolean) {
  const request: CompletionRequest = {
    provider: "codex", model, thinking: { enabled: true, effort: "high" },
    messages: [{ role: "user", content: "Review the provider transport." }],
  };
  return {
    provider: "codex" as const, model, systemContent: "Summarize", prompt: "Compact this session",
    maxTokens: 4096, stream: streaming, qualityRetry: true,
    requestSettings: successfulRequestSnapshot("codex", model, request),
    sourceMessages: request.messages,
  };
}

function reasoning(request: CompletionRequest) {
  return JSON.parse(buildResponsesBody(codexConfigFor({ accessToken: "fixture-token", accountId: "fixture-account" }), {
    model, messages: request.messages, reasoning: request.thinking, stream: true,
  })).reasoning;
}

beforeEach(() => {
  resetReasoningKnowledge();
  complete.mockReset().mockResolvedValue(summary);
  stream.mockReset().mockResolvedValue(summary);
});

describe.each([false, true])("ChatGPT compaction effort on retries (stream=%s)", (streaming) => {
  it.each(["reasoning-only", "empty-error"] as const)("retains literal high on a %s quality retry", async (mode) => {
    const dispatch = streaming ? stream : complete;
    if (mode === "empty-error") {
      dispatch.mockRejectedValueOnce(new Error("ChatGPT completed without a visible answer."));
    } else {
      dispatch.mockResolvedValueOnce({ ...summary, text: "", reasoningBlock: { text: "I reviewed the context." } });
    }
    expect(await executeCompactionSummary(execution(streaming))).toBe(summary.text);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map(([request]) => reasoning(request))).toEqual([
      { effort: "high", summary: "auto" }, { effort: "high", summary: "auto" },
    ]);
  });

  it("retains the request error when compatibility would remove the selected effort", async () => {
    const dispatch = streaming ? stream : complete;
    dispatch.mockRejectedValueOnce(Object.assign(new Error("Unsupported parameter: reasoning.summary"), { status: 400 }));
    await expect(executeCompactionSummary(execution(streaming))).rejects.toThrow("reasoning.summary");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(reasoning(dispatch.mock.calls[0]![0])).toEqual({ effort: "high", summary: "auto" });
  });

  it("retains effort when the output budget cannot grow after truncation", async () => {
    const dispatch = streaming ? stream : complete;
    dispatch.mockResolvedValueOnce({ ...summary, text: "## Work completed\nPartial", finishReason: "length" });
    await expect(executeCompactionSummary(execution(streaming))).rejects.toThrow(/output limit/);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(reasoning(dispatch.mock.calls[0]![0])).toEqual({ effort: "high", summary: "auto" });
  });
});
