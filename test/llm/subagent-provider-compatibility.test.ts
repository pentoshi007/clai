import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult, ToolChoice } from "../../src/types.js";
import type { LlmProvider } from "../../src/llm/provider.js";
import { freeProvider } from "../../src/llm/free.js";
import { ProviderError, buildChatBody } from "../../src/llm/http.js";
import {
  isReasoningUnsupported,
  registerWireRejectionEfforts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { lowestReasoningPreference, withLowestReasoning } from "../../src/llm/lowest-reasoning.js";
import { tryCompleteOnce } from "../../src/llm/routing/attempt-complete.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import { markStreamEmittedBytes } from "../../src/llm/stream-progress.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import { installTransport } from "../conformance/fake-transport.js";
import { jsonResponse } from "../conformance/wire-fixtures.js";

const model = "muse-spark-1.3-contributor-free";
const request: CompletionRequest = {
  provider: "free",
  model,
  messages: [{ role: "user", content: "Complete the delegated task" }],
  tools: [{ name: "fs.read", description: "Read a file", parameters: { type: "object", properties: {} } }],
  toolChoice: "auto",
};
const result: CompletionResult = { text: "done", provider: "free", model };
const config = structuredClone(getConfig());

beforeEach(() => {
  updateConfig({ learnedRouteCapabilities: {} });
  resetReasoningKnowledge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetReasoningKnowledge();
  updateConfig(config);
});

function run(
  mode: "complete" | "stream",
  provider: LlmProvider,
  input: CompletionRequest,
  singleDispatch = false,
  onToken: (token: string) => void = () => undefined,
): Promise<CompletionResult> {
  return mode === "complete"
    ? tryCompleteOnce(provider, "free", input, input.model ?? model, {}, "initial", undefined, singleDispatch)
    : tryStreamOnce(provider, "free", input, input.model ?? model, {}, onToken, undefined, "initial", singleDispatch);
}

function fakeProvider(attempt: (request: CompletionRequest) => Promise<CompletionResult>): LlmProvider {
  return { ...freeProvider, complete: attempt, stream: attempt };
}

describe.each(["complete", "stream"] as const)("%s provider option compatibility", (mode) => {
  it.each<ToolChoice>(["required", { type: "function", name: "fs.read" }])("retries auto-only tool choice without disabling tools (%j)", async (toolChoice) => {
    const attempt = vi.fn(async (candidate: CompletionRequest) => {
      if (candidate.toolChoice !== "auto") {
        throw new ProviderError("Request failed", 400, 'only "auto" is supported for tool_choice. "none", "required", and named function choices are not currently supported');
      }
      return result;
    });
    const input = { ...request, toolChoice };
    await expect(run(mode, fakeProvider(attempt), input)).resolves.toEqual(result);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[1]![0]).toMatchObject({ toolChoice: "auto", tools: request.tools, attemptReason: "adaptation" });
    expect(input.toolChoice).toEqual(toolChoice);
  });

  it("keeps an explicit no-tools request tool-free when only auto is supported", async () => {
    const attempt = vi.fn(async (candidate: CompletionRequest) => {
      if (candidate.toolChoice === "none") {
        throw new ProviderError("Request failed", 400, 'only "auto" is supported for tool_choice');
      }
      return result;
    });
    await run(mode, fakeProvider(attempt), { ...request, toolChoice: "none" });
    expect(attempt.mock.calls[1]![0]).toMatchObject({ tools: undefined, toolChoice: undefined, parallelToolCalls: undefined });
  });

  it("removes only rejected optional fields across successive failures", async () => {
    const attempt = vi.fn(async (candidate: CompletionRequest) => {
      if (candidate.parallelToolCalls !== undefined) {
        throw new ProviderError("Request failed", 422, "Unsupported parameter: parallel_tool_calls");
      }
      if (candidate.temperature !== undefined) {
        throw new ProviderError("Request failed", 400, "temperature is not supported with this model");
      }
      return result;
    });
    const input = { ...request, parallelToolCalls: true, temperature: 0.2 };
    await expect(run(mode, fakeProvider(attempt), input)).resolves.toEqual(result);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(attempt.mock.calls[2]![0]).toMatchObject({ tools: request.tools, toolChoice: "auto", temperature: undefined, parallelToolCalls: undefined });
    expect(input).toMatchObject({ temperature: 0.2, parallelToolCalls: true });
  });

  it("honors single-dispatch requests", async () => {
    const error = new ProviderError("Request failed", 400, 'only "auto" is supported for tool_choice');
    const attempt = vi.fn(async () => { throw error; });
    await expect(run(mode, fakeProvider(attempt), { ...request, toolChoice: "required" }, true)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("adapts rejected none effort to the lowest accepted value without changing parent preferences", async () => {
    const input = { ...request, model: "gpt-5.5", thinking: { enabled: true, effort: "high" as const } };
    const originalThinking = getConfig().thinking;
    const attempt = vi.fn(async (candidate: CompletionRequest) => {
      if (candidate.thinking?.effort === "none") {
        throw new ProviderError("Request failed", 400, 'reasoning_effort must be one of ["low", "medium", "high"]');
      }
      return result;
    });
    await run(mode, fakeProvider(attempt), withLowestReasoning(input, "free", input.model));
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[1]![0].thinking).toEqual({ enabled: true, effort: "low" });
    expect(lowestReasoningPreference("free", input.model)).toEqual({ enabled: true, effort: "low" });
    expect(input.thinking).toEqual({ enabled: true, effort: "high" });
    expect(getConfig().thinking).toEqual(originalThinking);
    expect(isReasoningUnsupported("free", input.model)).toBe(false);
    await run(mode, fakeProvider(attempt), input);
    expect(attempt.mock.calls[2]![0].thinking).toEqual({ enabled: true, effort: "high" });
  });

  it("tries increasing supported efforts when none is rejected without a value list", async () => {
    const attempt = vi.fn(async (candidate: CompletionRequest) => {
      if (["none", "minimal"].includes(candidate.thinking?.effort ?? "")) {
        throw new ProviderError("Request failed", 400, "Unsupported reasoning_effort");
      }
      return result;
    });
    await run(mode, fakeProvider(attempt), withLowestReasoning(request, "free", model));
    expect(attempt.mock.calls.map(([candidate]) => candidate.thinking?.effort))
      .toEqual(["none", "minimal", "low"]);
    expect(isReasoningUnsupported("free", model)).toBe(false);
    expect(lowestReasoningPreference("free", model))
      .toEqual({ enabled: true, effort: "low" });
  });

  it("does not adapt unrelated validation failures", async () => {
    const error = new ProviderError("Request failed", 400, "Invalid messages");
    const attempt = vi.fn(async () => { throw error; });
    await expect(run(mode, fakeProvider(attempt), request)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch an adaptation after cancellation", async () => {
    const controller = new AbortController();
    const aborted = new Error("Cancelled");
    const attempt = vi.fn(async () => {
      controller.abort(aborted);
      throw new ProviderError("Request failed", 400, "Unsupported temperature");
    });
    await expect(run(mode, fakeProvider(attempt), {
      ...request,
      temperature: 0.2,
      signal: controller.signal,
    })).rejects.toBe(aborted);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("lowest reasoning requests", () => {
  it("prefers none for optional reasoning and the lowest effort for mandatory models", () => {
    expect(lowestReasoningPreference("free", model)).toEqual({ enabled: false, effort: "none" });
    expect(lowestReasoningPreference("openai", "gpt-5.5")).toEqual({ enabled: true, effort: "minimal" });
    expect(lowestReasoningPreference("free", "kimi-k3")).toEqual({ enabled: true, effort: "low" });
    registerWireRejectionEfforts("free", "kimi-k3", ["high", "medium", "low"]);
    expect(lowestReasoningPreference("free", "kimi-k3")).toEqual({ enabled: true, effort: "low" });
    registerWireRejectionEfforts("free", "kimi-k3", ["medium"]);
    expect(lowestReasoningPreference("free", "kimi-k3")).toEqual({ enabled: true, effort: "medium" });
  });

  it("does not retry after visible stream output", async () => {
    const error = new ProviderError("Request failed", 400, "temperature is not supported");
    const stream = vi.fn(async (_input, _auth, emit) => {
      emit("visible");
      throw error;
    });
    const tokens: string[] = [];
    await expect(run("stream", { ...freeProvider, stream }, { ...request, temperature: 0.2 }, false, (token) => tokens.push(token))).rejects.toBe(error);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(["visible"]);
  });

  it("does not retry provider-marked output without a callback", async () => {
    const error = markStreamEmittedBytes(
      new ProviderError("Request failed", 400, "Unsupported temperature"),
      4,
    );
    const attempt = vi.fn(async () => { throw error; });
    await expect(run("stream", fakeProvider(attempt), {
      ...request,
      temperature: 0.2,
    })).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("uses the same free provider wire formatting and headers as a parent request", async () => {
    const transport = installTransport(() => jsonResponse({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
    }));
    const parent = { ...request, thinking: { enabled: true, effort: "high" as const } };
    await run("complete", freeProvider, parent);
    await run("complete", freeProvider, withLowestReasoning(parent, "free", model));
    const [main, child] = transport.generations;
    expect(main).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.url).toEqual(main!.url);
    expect(child!.headers).toEqual(main!.headers);
    expect(child!.body).toMatchObject({ model, tool_choice: "auto", tools: (main!.body as Record<string, unknown>).tools });
    expect(parent.thinking).toEqual({ enabled: true, effort: "high" });
  });

  it("keeps parent cache affinity stable around child requests", () => {
    const parent = { ...request, provider: "openrouter" as const, model: "openai/gpt-5.5", thinking: { enabled: true, effort: "high" as const } };
    const body = (input: CompletionRequest): Record<string, unknown> => JSON.parse(buildChatBody({
      providerId: input.provider,
      model: input.model!,
      messages: input.messages,
      stream: false,
      reasoning: input.thinking,
      reasoningStyle: "openrouter",
    }));
    const before = body(parent);
    const child = body(withLowestReasoning({ ...parent, messages: [{ role: "user", content: "Separate delegated goal" }] }, "openrouter", parent.model));
    const after = body(parent);
    expect(after).toEqual(before);
    expect(child.session_id).not.toEqual(before.session_id);
    expect(before.session_id).toBeDefined();
  });
});
