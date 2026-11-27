import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCurrentAgentPort } from "../../src/app/adapters/current-agent-adapter.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { buildChatBody } from "../../src/llm/http.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { META_STREAM_TERMINAL } from "../../src/llm/stream-terminal.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import { accountAssembledRequest } from "../../src/agent/request-accounting.js";
import type { StreamWithProviderOptions } from "../../src/llm/router.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import { createPlan, deletePlan, loadPlan, savePlan } from "../../src/store/plan.js";
import type { CompletionRequest, CompletionResult, ProviderId, ToolCall } from "../../src/types.js";

const stream = vi.fn();
const complete = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/llm/router.js")>(),
  streamWithProvider: (...args: unknown[]) => stream(...args),
  completeWithProvider: (...args: unknown[]) => complete(...args),
}));
vi.mock("../../src/commands/providers.js", () => ({ ensureProviderConfigured: async () => {} }));
vi.mock("../../src/llm/catalog-prefetch.js", () => ({ prefetchProviderCatalog: async () => {} }));

type WireDialect = "chat" | "responses";
type Step = { readonly text?: string; readonly calls?: readonly ToolCall[] };

const SUMMARY = "## Work completed\n- Read the module and recorded its exports.\n\n## Remaining work\n- Implement the remaining tasks.";
const originalThinking = getConfig().thinking;
const originalToolCalling = getConfig().toolCalling;
let cwd: string;
let directory: string;
let session: SessionController | undefined;

beforeEach(async () => {
  cwd = process.cwd();
  directory = await mkdtemp(join(tmpdir(), "clai-agent-cache-"));
  process.chdir(directory);
  updateConfig({ thinking: { enabled: true, effort: "high" }, toolCalling: "native" });
  stream.mockReset();
  complete.mockReset();
});

afterEach(async () => {
  session?.dispose();
  session = undefined;
  updateConfig({ thinking: originalThinking, toolCalling: originalToolCalling });
  process.chdir(cwd);
  await rm(directory, { recursive: true, force: true });
});

function wire(request: CompletionRequest, dialect: WireDialect): unknown[] {
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
        displayName: "Agent cache fixture",
        artifactDialect: "openai-compatible",
        terminalPolicy: META_STREAM_TERMINAL,
        buildHeaders: () => ({}),
        reasoningPayload: () => undefined,
        bodyExtras: () => ({}),
      }, options));
  return body.input ?? body.messages;
}

function sharedPrefix(previous: unknown[], next: unknown[]): number {
  let index = 0;
  while (index < previous.length && JSON.stringify(previous[index]) === JSON.stringify(next[index])) index += 1;
  return index;
}

function expectExtends(previous: CompletionRequest, next: CompletionRequest, dialect: WireDialect, label: string): void {
  const before = wire(previous, dialect);
  const after = wire(next, dialect);
  expect({ label, shared: sharedPrefix(before, after), of: before.length }).toEqual({ label, shared: before.length, of: before.length });
  expect(next.tools).toEqual(previous.tools);
  expect(next.thinking).toEqual(previous.thinking);
  expect(next.toolChoice).toEqual(previous.toolChoice);
  expect(next.parallelToolCalls).toEqual(previous.parallelToolCalls);
}

function expectCompactionReusesPrefix(previous: CompletionRequest, compaction: CompletionRequest, label: string): void {
  const before = wire(previous, "responses");
  const after = wire(compaction, "responses");
  const reused = Math.min(before.length, after.length - 1);
  expect({ label, shared: sharedPrefix(before, after) }).toEqual({ label, shared: reused });
  expect(reused).toBeGreaterThan(before.length / 2);
  expect(compaction.tools).toEqual(previous.tools);
  expect(compaction.thinking).toEqual(previous.thinking);
}

function scriptedProvider(provider: ProviderId, model: string, steps: Step[], requests: CompletionRequest[]): void {
  const reply = (step: Step | undefined): CompletionResult => step?.calls?.length
    ? { provider, model, text: step.text ?? "", finishReason: "tool_calls", toolCalls: [...step.calls] }
    : { provider, model, text: step?.text ?? SUMMARY, finishReason: "stop" };
  stream.mockImplementation(async (request: CompletionRequest, onToken: (text: string) => void, options?: StreamWithProviderOptions) => {
    requests.push({ ...successfulRequestSnapshot(provider, model, request), purpose: request.purpose });
    options?.onSuccessfulRequest?.(successfulRequestSnapshot(provider, model, request));
    const result = reply(request.purpose === "compaction" ? { text: SUMMARY } : steps.shift());
    if (result.text) onToken(result.text);
    return result;
  });
  complete.mockImplementation(async (request: CompletionRequest) => {
    requests.push({ ...successfulRequestSnapshot(provider, model, request), purpose: request.purpose });
    return reply({ text: request.purpose === "compaction" ? SUMMARY : "TITLE: Agent cache" });
  });
}

async function startSession(provider: ProviderId, model: string, sessionId: string): Promise<SessionController> {
  const plan = createPlan({
    sessionId,
    goal: "Ship the exports module",
    detail: `Keep the public API stable. ${"Design note. ".repeat(4_000)}`,
    kind: "coding",
    taskTitles: ["Read the exports module", "Add the new export", "Run the tests"],
  });
  plan.status = "approved";
  await savePlan(plan);
  const controller = new SessionController({
    agent: createCurrentAgentPort(), mode: "agent", provider, model, sessionId,
    emit: () => {}, noHistory: true, titleCompleter: async () => "TITLE: Agent cache",
    persistence: {
      saveSession: async () => {}, loadPlan: async () => loadPlan(sessionId),
      savePlan: async () => {}, deletePlan: async () => {},
    },
  });
  controller.setPlanApproved(true);
  controller.setContextLimitTokens(1_000_000);
  return controller;
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, args });

describe("agent-mode cache continuity with a live plan", () => {
  it.each<[ProviderId, string, WireDialect]>([
    ["explabs", "gpt-5.6-luna", "chat"],
    ["openai", "gpt-5", "responses"],
  ])("keeps %s %s %s prefixes through tool steps, task updates, a follow-up and plan-implement compaction", async (provider, model, dialect) => {
    const sessionId = `agent-cache-${provider}-${dialect}`;
    const file = join(directory, "exports.ts");
    await writeFile(file, `export const value = 1;\n${"// filler line\n".repeat(400)}`);
    const requests: CompletionRequest[] = [];
    scriptedProvider(provider, model, [
      { calls: [call("u1", "task.update", { updates: [{ state: "in_progress", taskIds: ["t1"] }] })] },
      { calls: [call("r1", "fs.read", { path: file })] },
      { calls: [call("u2", "task.update", { updates: [{ state: "done", taskIds: ["t1"] }] })] },
      { text: "Read the module; t2 and t3 remain.", calls: [call("e1", "turn.end", { status: "partial", summary: "t1 done" })] },
      { text: "It exports `value`.", calls: [call("e2", "turn.end", { status: "partial", summary: "answered" })] },
    ], requests);
    try {
      session = await startSession(provider, model, sessionId);
      await session.submit("Implement the approved plan.");
      const firstTurn = requests.length;
      await session.submit("What does the module export? Answer without tools.");
      const followUp = requests.length;
      expect((await session.compact(undefined, 2, undefined, { persist: false, purpose: "plan-implement" })).summarized).toBe(true);
      expect(requests.at(-1)!.purpose).toBe("compaction");
      expect(firstTurn).toBeGreaterThanOrEqual(4);
      expect(followUp).toBeGreaterThan(firstTurn);
      for (let index = 1; index < requests.length; index += 1) {
        expectExtends(requests[index - 1]!, requests[index]!, dialect, `request ${index} (${requests[index]!.purpose})`);
      }
    } finally {
      await deletePlan(sessionId);
    }
  }, 60_000);

  it.each([
    ["before the next turn", 0],
    ["mid-turn after a tool result", 30_000],
  ] as const)("reuses the cached prefix for automatic compaction %s", async (_when, headroom) => {
    const provider: ProviderId = "openai";
    const model = "gpt-5";
    const sessionId = `agent-cache-auto-${headroom}`;
    const file = join(directory, "big.ts");
    await writeFile(file, `${"export const filler = 'value';\n".repeat(6_000)}`);
    const requests: CompletionRequest[] = [];
    scriptedProvider(provider, model, [
      { calls: [call("u1", "task.update", { updates: [{ state: "in_progress", taskIds: ["t1"] }] })] },
      { calls: [call("r1", "fs.read", { path: file })] },
      { calls: [call("r2", "fs.read", { path: file, offset: 2_000, limit: 2_000 })] },
      { text: "Read it." },
    ], requests);
    try {
      session = await startSession(provider, model, sessionId);
      await session.submit("Implement the approved plan.");
      const last = requests.at(-1)!;
      const tokens = accountAssembledRequest({ provider, model, messages: last.messages, tools: last.tools, reasoning: last.thinking, stream: true }).accounting.requestTokens;
      session.setContextLimitTokens(Math.ceil((tokens + headroom) / 0.8));
      scriptedProvider(provider, model, [
        { calls: [call("r3", "fs.read", { path: file, offset: 4_000, limit: 2_000 })] },
        { calls: [call("r4", "fs.read", { path: file, offset: 1, limit: 2_000 })] },
        { calls: [call("r5", "fs.read", { path: file, offset: 2_001, limit: 1_999 })] },
        { text: "Done." },
      ], requests);
      const before = requests.length;
      await session.submit("Read the last part of the file.");
      const compaction = requests.findIndex((request, index) => index >= before && request.purpose === "compaction");
      expect(compaction).toBeGreaterThanOrEqual(before);
      expect(compaction > before).toBe(headroom > 0);
      expectCompactionReusesPrefix(requests[compaction - 1]!, requests[compaction]!, "auto compaction");
    } finally {
      await deletePlan(sessionId);
    }
  }, 60_000);
});
