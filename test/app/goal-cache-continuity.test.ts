import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCurrentAgentPort } from "../../src/app/adapters/current-agent-adapter.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { buildChatBody } from "../../src/llm/http.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { buildKiroRequestBody, resolveKiroModel } from "../../src/llm/kiro.js";
import { META_STREAM_TERMINAL } from "../../src/llm/stream-terminal.js";
import { currentSessionAffinity } from "../../src/llm/session-affinity.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import type { StreamWithProviderOptions } from "../../src/llm/router.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import { GOAL_EVALUATION_MARKER, GOAL_PROMPT_MARKER } from "../../src/agent/goal/goal-prompts.js";
import type { CompletionRequest, ProviderId } from "../../src/types.js";

const stream = vi.fn();
const complete = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/llm/router.js")>(),
  streamWithProvider: (...args: unknown[]) => stream(...args),
  completeWithProvider: (...args: unknown[]) => complete(...args),
}));
vi.mock("../../src/commands/providers.js", () => ({ ensureProviderConfigured: async () => {} }));
vi.mock("../../src/llm/catalog-prefetch.js", () => ({ prefetchProviderCatalog: async () => {} }));

const originalThinking = getConfig().thinking;
let cwd: string;
let directory: string;
let session: SessionController | undefined;

beforeEach(async () => {
  cwd = process.cwd();
  directory = await mkdtemp(join(tmpdir(), "clai-goal-cache-"));
  process.chdir(directory);
  updateConfig({ thinking: { enabled: true, effort: "high" } });
  stream.mockReset();
  complete.mockReset();
});

afterEach(async () => {
  session?.dispose();
  session = undefined;
  updateConfig({ thinking: originalThinking });
  process.chdir(cwd);
  await rm(directory, { recursive: true, force: true });
});

type WireDialect = "chat" | "responses" | "kiro";

function kiroWire(request: CompletionRequest): unknown[] {
  const route = resolveKiroModel(request.model!);
  const body = buildKiroRequestBody(
    request,
    { accessToken: "fixture", authMethod: "social" },
    route.upstream,
    route.agentic,
    route.thinking,
  );
  const state = body.conversationState as {
    history: unknown[];
    currentMessage: { userInputMessage: { userInputMessageContext: Record<string, unknown> } };
  };
  const current = structuredClone(state.currentMessage);
  delete current.userInputMessage.userInputMessageContext.tools;
  return [...state.history, current];
}

function wire(request: CompletionRequest, dialect: WireDialect): unknown[] {
  if (dialect === "kiro") return kiroWire(request);
  const options = {
    model: request.model!,
    messages: request.messages,
    stream: true,
    tools: request.tools,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    reasoning: request.thinking,
  };
  const body = JSON.parse(dialect === "chat"
    ? buildChatBody({ ...options, providerId: request.provider })
    : buildResponsesBody({
        providerId: request.provider!,
        baseUrl: "https://example.invalid/v1",
        displayName: "Goal cache fixture",
        artifactDialect: "openai-compatible",
        terminalPolicy: META_STREAM_TERMINAL,
        buildHeaders: () => ({}),
        reasoningPayload: () => undefined,
        bodyExtras: () => ({}),
      }, options));
  return body.input ?? body.messages;
}

function expectExtends(previous: CompletionRequest, next: CompletionRequest, dialect: WireDialect): void {
  const prefix = wire(previous, dialect);
  expect(JSON.stringify(wire(next, dialect).slice(0, prefix.length)) === JSON.stringify(prefix)).toBe(true);
  expect(next.tools).toEqual(previous.tools);
  expect(next.thinking).toEqual(previous.thinking);
  expect(next.toolChoice).toEqual(previous.toolChoice);
  expect(next.parallelToolCalls).toEqual(previous.parallelToolCalls);
  expect(next.temperature).toEqual(previous.temperature);
}

describe("/goal cache continuity", () => {
  it.each<[ProviderId, string, WireDialect]>([
    ["explabs", "gpt-5.6-luna", "chat"],
    ["explabs", "gpt-5.6-luna", "responses"],
    ["openai", "gpt-5", "responses"],
    ["kiro", "claude-opus-5.5-thinking", "kiro"],
  ])("keeps %s %s %s prefixes, settings and affinity across kickoff, evaluation and continuation", async (provider, model, dialect) => {
    const path = join(directory, "one.ts");
    await writeFile(path, "export const value = 1;\n");
    const requests: (CompletionRequest & { readonly purpose?: CompletionRequest["purpose"] })[] = [];
    const affinities: Array<string | undefined> = [];
    let mainCalls = 0;
    stream.mockImplementation(async (request: CompletionRequest, onToken: (text: string) => void, options?: StreamWithProviderOptions) => {
      mainCalls += 1;
      requests.push({ ...successfulRequestSnapshot(provider, model, request), purpose: request.purpose });
      affinities.push(currentSessionAffinity());
      options?.onSuccessfulRequest?.(successfulRequestSnapshot(provider, model, request));
      if (mainCalls === 1) {
        return { provider, model, text: "", finishReason: "tool_calls", toolCalls: [{ id: "read-1", name: "fs.read", args: { path, offset: 1, limit: 1 } }] };
      }
      const answer = `Checked the file and reported the value (${mainCalls}).`;
      onToken(answer);
      return { provider, model, text: answer, finishReason: "stop" };
    });
    const verdicts = [
      { verdict: "not_met", reason: "the value was not explained", next_step: "explain the value" },
      { verdict: "met", reason: "the value is explained" },
    ];
    complete.mockImplementation(async (request: CompletionRequest) => {
      requests.push({ ...successfulRequestSnapshot(provider, model, request), purpose: request.purpose });
      affinities.push(currentSessionAffinity());
      return { provider, model, text: JSON.stringify(verdicts.shift()), finishReason: "stop" };
    });
    const sessionId = `goal-cache-${provider}-${dialect}`;
    session = new SessionController({
      agent: createCurrentAgentPort(), mode: "ask", provider, model, sessionId,
      emit: () => {}, noHistory: true,
      persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    });
    session.setContextLimitTokens(1_000_000);
    expect(session.setGoal(`one.ts is read and its value explained\n${"Relevant evidence. ".repeat(150)}`)).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(requests).toHaveLength(5);
      expect(session!.getState().goal).toBeUndefined();
      expect(session!.getState().running).toBe(false);
    }, { timeout: 20_000 });

    expect(requests.map((request) => request.purpose ?? "turn")).toEqual(["turn", "turn", "evaluation", "turn", "evaluation"]);
    const [kickoffTool, kickoffAnswer, firstEvaluation, continuation, secondEvaluation] = requests as [
      CompletionRequest, CompletionRequest, CompletionRequest, CompletionRequest, CompletionRequest,
    ];
    expectExtends(kickoffTool, kickoffAnswer, dialect);
    expectExtends(kickoffAnswer, firstEvaluation, dialect);
    expectExtends(kickoffAnswer, continuation, dialect);
    expectExtends(continuation, secondEvaluation, dialect);
    expect(firstEvaluation.messages.at(-1)).toMatchObject({ role: "user", internal: true });
    expect(firstEvaluation.messages.at(-1)!.content).toContain(GOAL_EVALUATION_MARKER);
    expect(new Set(affinities)).toEqual(new Set([sessionId]));

    const history = session.messages;
    expect(history.some((message) => message.content.includes(GOAL_EVALUATION_MARKER))).toBe(false);
    const goalPrompts = history.filter((message) => message.role === "user" && message.content.startsWith(GOAL_PROMPT_MARKER));
    expect(goalPrompts.map((message) => message.internal === true)).toEqual([false, true]);
    expect(goalPrompts[1]!.content).toContain("Evaluator reason: the value was not explained");
  }, 60_000);
});
