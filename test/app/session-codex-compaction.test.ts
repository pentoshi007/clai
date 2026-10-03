import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCurrentAgentPort } from "../../src/app/adapters/current-agent-adapter.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { accountAssembledRequest } from "../../src/agent/request-accounting.js";
import { codexProvider, resetCodexModelCache } from "../../src/llm/codex.js";
import { codexConfigFor } from "../../src/llm/codex-config.js";
import { encodeCodexKey } from "../../src/llm/codex-auth.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import type { StreamWithProviderOptions } from "../../src/llm/router.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import type { ChatMessage, CompletionRequest, CompletionResult, ReasoningEffort } from "../../src/types.js";

const stream = vi.fn();
const complete = vi.fn();
vi.mock("../../src/llm/router.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/llm/router.js")>(),
  streamWithProvider: (...args: unknown[]) => stream(...args),
  completeWithProvider: (...args: unknown[]) => complete(...args),
}));
vi.mock("../../src/commands/providers.js", () => ({ ensureProviderConfigured: async () => {} }));
vi.mock("../../src/llm/catalog-prefetch.js", () => ({ prefetchProviderCatalog: async () => {} }));

const model = "gpt-6.1-sol";
const credential = { accessToken: "fixture-token", accountId: "fixture-account" };
const summary = "## Work completed\n- Reviewed the supplied evidence and recorded the findings.\n\n## Remaining work\n- Continue from the retained conversation.";
const originalThinking = getConfig().thinking;
let previousCwd: string;
let directory: string;
let session: SessionController | undefined;

function history(): ChatMessage[] {
  return Array.from({ length: 3 }, (_, index): ChatMessage[] => [
    { role: "user", content: `Evidence ${index}: ${"evidence detail ".repeat(15_000)}` },
    { role: "assistant", content: `Finding ${index} is recorded.` },
  ]).flat();
}

function createSession(): SessionController {
  session = new SessionController({
    agent: createCurrentAgentPort(), provider: "codex", model, sessionId: "codex-compaction",
    emit: () => {}, noHistory: true, titleCompleter: async () => "Compaction fixture",
    persistence: {
      saveSession: async () => {}, loadPlan: async () => undefined,
      savePlan: async () => {}, deletePlan: async () => {},
    },
  });
  session.setContextLimitTokens(1_000_000);
  session.restoreMessages(history());
  return session;
}

function body(request: CompletionRequest): Record<string, unknown> {
  return JSON.parse(buildResponsesBody(codexConfigFor(credential), {
    model: request.model!, messages: request.messages, reasoning: request.thinking, stream: true,
    tools: request.tools, toolChoice: request.toolChoice, parallelToolCalls: request.parallelToolCalls,
    purpose: request.purpose,
  }));
}

function runtime(snapshot = false, stopFirst = true) {
  const requests: CompletionRequest[] = [];
  let stopNext = stopFirst;
  let started!: (request: CompletionRequest) => void;
  const firstRequest = new Promise<CompletionRequest>((resolve) => { started = resolve; });
  const finish = (request: CompletionRequest): CompletionResult => {
    requests.push(request);
    return { provider: "codex", model, text: summary, finishReason: "stop" };
  };
  stream.mockImplementation(async (request: CompletionRequest, onToken: (text: string) => void, options?: StreamWithProviderOptions) => {
    if (request.purpose !== "compaction" && stopNext) {
      stopNext = false;
      requests.push(request);
      if (snapshot) options?.onSuccessfulRequest?.(successfulRequestSnapshot("codex", model, request));
      started(request);
      return new Promise<CompletionResult>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("Stopped by user"), { name: "AbortError" }));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const result = finish(request);
    options?.onSuccessfulRequest?.(successfulRequestSnapshot("codex", model, request));
    onToken(summary);
    return result;
  });
  complete.mockImplementation(async (request: CompletionRequest) => finish(request));
  return { requests, firstRequest };
}

async function stopTurn(current: SessionController, capture: ReturnType<typeof runtime>): Promise<CompletionRequest> {
  const turn = current.submit("Inspect the evidence without tools.");
  const request = await capture.firstRequest;
  current.abort();
  const result = await turn;
  expect(result).toMatchObject({ status: "completed", outcome: { status: "aborted" } });
  expect(request.signal?.aborted).toBe(true);
  return request;
}

beforeEach(async () => {
  previousCwd = process.cwd();
  directory = await mkdtemp(join(tmpdir(), "clai-codex-compaction-"));
  process.chdir(directory);
  updateConfig({ thinking: { enabled: true, effort: "max" } });
  stream.mockReset();
  complete.mockReset();
  resetCodexModelCache();
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    expect(String(url)).toContain("/models?");
    return new Response(JSON.stringify({ models: [{
      slug: model, context_window: 1_000_000, default_reasoning_level: "low",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      default_reasoning_summary: "none", supports_reasoning_summary_parameter: true,
    }] }), { headers: { "content-type": "application/json" } });
  }));
  await codexProvider.listModels!({ apiKey: encodeCodexKey(credential) });
});

afterEach(async () => {
  session?.dispose();
  session = undefined;
  updateConfig({ thinking: originalThinking });
  process.chdir(previousCwd);
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  resetCodexModelCache();
});

describe("ChatGPT compaction after stop", () => {
  it.each<ReasoningEffort>(["low", "medium", "high", "xhigh", "max"])("keeps selected %s effort for manual compaction without a snapshot", async (effort) => {
    updateConfig({ thinking: { enabled: true, effort } });
    const capture = runtime();
    const current = createSession();
    const stopped = await stopTurn(current, capture);
    const result = await current.compact(undefined, 2, undefined, { persist: false });
    expect(result.summarized).toBe(true);
    const compact = capture.requests.find((request) => request.purpose === "compaction")!;
    expect(body(stopped).reasoning).toEqual({ effort, summary: "auto" });
    expect(body(compact).reasoning).toEqual({ effort, summary: "auto" });
    expect(compact.signal).toBeDefined();
    expect(compact.signal).not.toBe(stopped.signal);
    expect(compact.signal?.aborted).toBe(false);
    expect((await current.submit("Continue without tools.")).status).toBe("completed");
    expect(body(capture.requests.at(-1)!).reasoning).toEqual({ effort, summary: "auto" });
  });

  it.each(["high", "max"] as const)("preserves a captured request's %s effort and tools after the selection changes", async (effort) => {
    updateConfig({ thinking: { enabled: true, effort } });
    const capture = runtime(true);
    const current = createSession();
    const stopped = await stopTurn(current, capture);
    updateConfig({ thinking: { enabled: true, effort: "low" } });
    expect((await current.compact(undefined, 2, undefined, { persist: false })).summarized).toBe(true);
    const compact = capture.requests.find((request) => request.purpose === "compaction")!;
    expect(body(compact).reasoning).toEqual({ effort, summary: "auto" });
    expect(compact.tools).toEqual(stopped.tools);
    expect(compact.toolChoice).toEqual(stopped.toolChoice);
    expect(compact.messages.slice(0, stopped.messages.length)).toEqual(stopped.messages);
    expect(compact.signal).not.toBe(stopped.signal);
  });

  it.each([
    { effort: "high", snapshot: false }, { effort: "high", snapshot: true },
    { effort: "max", snapshot: false }, { effort: "max", snapshot: true },
  ] as const)("keeps $effort effort and a fresh signal for automatic compaction on resume (snapshot=$snapshot)", async ({ effort, snapshot }) => {
    updateConfig({ thinking: { enabled: true, effort } });
    const capture = runtime(snapshot);
    const current = createSession();
    const stopped = await stopTurn(current, capture);
    const tokens = accountAssembledRequest({
      provider: "codex", model, messages: stopped.messages, tools: stopped.tools,
      reasoning: stopped.thinking, stream: true,
    }).accounting.requestTokens;
    current.setContextLimitTokens(Math.ceil(tokens / 0.8));
    expect((await current.submit("Continue the evidence review without tools.")).status).toBe("completed");
    const compactions = capture.requests.filter((request) => request.purpose === "compaction");
    expect(compactions).toHaveLength(1);
    expect(body(compactions[0]!).reasoning).toEqual({ effort, summary: "auto" });
    expect(compactions[0]!.signal).not.toBe(stopped.signal);
    expect(compactions[0]!.signal?.aborted).toBe(false);
    expect(body(capture.requests.at(-1)!).reasoning).toEqual({ effort, summary: "auto" });
  });
});

describe("ChatGPT compaction after restore", () => {
  it.each(["high", "max"] as const)("keeps %s effort for automatic compaction before the first restored-session request", async (effort) => {
    updateConfig({ thinking: { enabled: true, effort } });
    const capture = runtime(false, false);
    const current = createSession();
    current.setContextLimitTokens(250_000);
    expect((await current.submit("Continue the restored review without tools.")).status).toBe("completed");
    const compactions = capture.requests.filter((request) => request.purpose === "compaction");
    expect(compactions).toHaveLength(1);
    expect(body(compactions[0]!).reasoning).toEqual({ effort, summary: "auto" });
    expect(body(capture.requests.at(-1)!).reasoning).toEqual({ effort, summary: "auto" });
  });

  it.each(["high", "max"] as const)("keeps %s effort without a successful request or assembled request measurement", async (effort) => {
    updateConfig({ thinking: { enabled: true, effort } });
    const capture = runtime();
    const current = createSession();
    expect(current.getState().contextUsage?.scope).not.toBe("assembled-request");
    expect((await current.compact(undefined, 2, undefined, { persist: false })).summarized).toBe(true);
    expect(body(capture.requests[0]!).reasoning).toEqual({ effort, summary: "auto" });
    expect(capture.requests[0]!.signal?.aborted).toBe(false);
  });

  it("respects disabled thinking during manual compaction", async () => {
    updateConfig({ thinking: { enabled: false, effort: "max" } });
    const capture = runtime();
    const current = createSession();
    expect((await current.compact(undefined, 2, undefined, { persist: false })).summarized).toBe(true);
    expect(capture.requests[0]!.thinking).toEqual({ enabled: false, effort: "max" });
    expect(body(capture.requests[0]!).reasoning).toEqual({ effort: "low" });
  });

  it("retains history when summarization fails", async () => {
    runtime();
    const current = createSession();
    const before = structuredClone(current.messages);
    complete.mockRejectedValueOnce(new Error("Fixture summary failed"));
    await expect(current.compact(undefined, 2, undefined, { persist: false })).rejects.toThrow("Fixture summary failed");
    expect(current.messages).toEqual(before);
    expect(current.getState().compacting).toBe(false);
  });
});
