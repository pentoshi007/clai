import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCurrentAgentPort } from "../../src/app/adapters/current-agent-adapter.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { buildChatBody } from "../../src/llm/http.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { META_STREAM_TERMINAL } from "../../src/llm/stream-terminal.js";
import { currentSessionAffinity } from "../../src/llm/session-affinity.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import { accountAssembledRequest } from "../../src/agent/request-accounting.js";
import type { StreamWithProviderOptions } from "../../src/llm/router.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
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

const summary = "## Work completed\n- Reviewed the supplied evidence and explained the findings.\n\n## Remaining work\n- No outstanding questions.";
const originalThinking = getConfig().thinking;
let cwd: string;
let directory: string;
let session: SessionController | undefined;

beforeEach(async () => {
  cwd = process.cwd();
  directory = await mkdtemp(join(tmpdir(), "clai-cache-continuity-"));
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

function wire(request: CompletionRequest, dialect: "chat" | "responses"): unknown[] {
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
        displayName: "Cache continuity fixture",
        artifactDialect: "openai-compatible",
        terminalPolicy: META_STREAM_TERMINAL,
        buildHeaders: () => ({}),
        reasoningPayload: () => undefined,
        bodyExtras: () => ({}),
      }, options));
  return body.input ?? body.messages;
}

describe("production session cache continuity", () => {
  it.each<[ProviderId, string, "chat" | "responses", "manual" | "automatic"]>([
    ["explabs", "gpt-5.6-luna", "chat", "manual"],
    ["explabs", "gpt-5.6-luna", "responses", "manual"],
    ["openai", "gpt-5", "responses", "manual"],
    ["explabs", "gpt-5.6-luna", "chat", "automatic"],
    ["explabs", "gpt-5.6-luna", "responses", "automatic"],
    ["openai", "gpt-5", "responses", "automatic"],
  ])("preserves large %s %s %s prefixes through completed turns, queued prompts and %s compaction", async (provider, model, dialect, compaction) => {
    const requests: CompletionRequest[] = [];
    const affinities: Array<string | undefined> = [];
    const capture = (request: CompletionRequest) => {
      requests.push({ ...successfulRequestSnapshot(provider, model, request), purpose: request.purpose });
      affinities.push(currentSessionAffinity());
      return { provider, model, text: summary, finishReason: "stop" as const };
    };
    stream.mockImplementation(async (request: CompletionRequest, onToken: (text: string) => void, options?: StreamWithProviderOptions) => {
      const result = capture(request);
      options?.onSuccessfulRequest?.(successfulRequestSnapshot(provider, model, request));
      onToken(summary);
      return result;
    });
    complete.mockImplementation(async (request: CompletionRequest) => capture(request));
    session = new SessionController({
      agent: createCurrentAgentPort(),
      provider,
      model,
      sessionId: `cache-${provider}-${dialect}`,
      emit: () => {},
      noHistory: true,
      titleCompleter: async () => "Cache continuity",
      persistence: {
        saveSession: async () => {},
        loadPlan: async () => undefined,
        savePlan: async () => {},
        deletePlan: async () => {},
      },
    });
    session.setContextLimitTokens(1_000_000);
    const first = await session.submit(`Explain this evidence without tools:\n${"evidence detail ".repeat(45_000)}`);
    expect(first.status).toBe("completed");
    expect(requests).toHaveLength(1);
    const followUp = await session.submit("Explain the conclusion in more detail without tools.");
    expect(followUp.status).toBe("completed");
    session.enqueue("Explain the remaining implications without tools.");
    session.enqueue("Summarize the explanation without tools.");
    await session.drain();
    expect(requests).toHaveLength(4);
    const last = requests.at(-1)!;
    const requestTokens = accountAssembledRequest({
      provider,
      model,
      messages: last.messages,
      tools: last.tools,
      reasoning: last.thinking,
      stream: true,
    }).accounting.requestTokens;
    expect(requestTokens).toBeGreaterThan(190_000);
    if (compaction === "manual") {
      const compacted = await session.compact(undefined, 2, undefined, { persist: false });
      expect(compacted.summarized).toBe(true);
      expect(requests).toHaveLength(5);
    } else {
      session.setContextLimitTokens(Math.ceil(requestTokens / 0.8));
      const continued = await session.submit("Explain the final implications without tools.");
      expect(continued.status).toBe("completed");
      expect(requests).toHaveLength(6);
      expect(JSON.stringify(requests[5]!.messages).length).toBeLessThan(JSON.stringify(last.messages).length);
    }
    expect(requests[4]!.purpose).toBe("compaction");
    expect(new Set(affinities)).toEqual(new Set([`cache-${provider}-${dialect}`]));
    for (let index = 1; index <= 4; index += 1) {
      const previous = requests[index - 1]!;
      const next = requests[index]!;
      const prefix = wire(previous, dialect);
      expect(JSON.stringify(wire(next, dialect).slice(0, prefix.length)) === JSON.stringify(prefix)).toBe(true);
      expect(next.tools).toEqual(previous.tools);
      expect(next.toolChoice).toEqual(previous.toolChoice);
      expect(next.parallelToolCalls).toEqual(previous.parallelToolCalls);
      expect(next.thinking).toEqual(previous.thinking);
    }
  });
});
