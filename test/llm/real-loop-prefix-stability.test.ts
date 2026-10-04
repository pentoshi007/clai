import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "../../src/agent/runner.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { updateConfig } from "../../src/store/config.js";
import { setProviderSecret } from "../../src/store/keys.js";
import type { ChatMessage, ProviderId } from "../../src/types.js";
import { buildWireResponse } from "../conformance/wire-fixtures.js";

vi.mock("../../src/commands/providers.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/commands/providers.js")>()),
  ensureProviderConfigured: async () => undefined,
}));

interface WireRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly tools: string;
  readonly messages: readonly string[];
}

type Step = { readonly tool: string; readonly args: Readonly<Record<string, unknown>> } | { readonly text: string };

const TURNS: ReadonlyArray<{ readonly prompt: string; readonly steps: readonly Step[] }> = [
  {
    prompt: "Review the repository package.json and tell me the package name and version.",
    steps: [
      { tool: "fs.read", args: { path: "package.json" } },
      { tool: "fs.read", args: { path: "src" } },
      { text: "The package is @pentoshi/clai." },
    ],
  },
  {
    prompt: "Now look at the tsconfig and summarize the compiler options.",
    steps: [
      { tool: "fs.read", args: { path: "tsconfig.json" } },
      { text: "Strict mode with NodeNext modules." },
    ],
  },
  {
    prompt: "Thanks. One more check: what is in the test directory?",
    steps: [
      { tool: "fs.read", args: { path: "test" } },
      { tool: "fs.read", args: { path: "vitest.config.ts" } },
      { text: "The test directory holds the vitest suites." },
    ],
  },
];

const ROUTES: ReadonlyArray<readonly [ProviderId, string]> = [
  ["cline", "cline-free/deepseek-v4.1-flash"],
  ["openrouter", "deepseek/deepseek-chat"],
  ["deepseek", "deepseek-chat"],
  ["openai", "gpt-5.4-mini"],
  ["fireworks", "accounts/fireworks/models/kimi-k2p6"],
  ["tokenrouter", "moonshotai/kimi-k3"],
  ["merge-gateway", "openai/gpt-5.2"],
];

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function wireToolName(body: Record<string, unknown>, canonical: string): string {
  const pattern = new RegExp(`^${canonical.replace(/\./g, "[._]")}$`);
  const tools = (body.tools as Array<{ name?: string; function?: { name?: string } }> | undefined) ?? [];
  return tools.map((tool) => tool.function?.name ?? tool.name ?? "").find((name) => pattern.test(name)) ?? canonical.replace(/\./g, "_");
}

function promptItems(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.messages)) return body.messages.map((message) => JSON.stringify(message));
  const input = Array.isArray(body.input) ? body.input : [];
  return [JSON.stringify(body.instructions ?? null), ...input.map((item) => JSON.stringify(item))];
}

function reply(step: Step, round: number, reasoning: boolean, body: Record<string, unknown>): Response {
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } };
  const thinking = reasoning
    ? [sse({ id: "r", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", reasoning: `Thinking through round ${round}.` }, finish_reason: null }] })]
    : [];
  if ("text" in step) {
    return streamResponse([
      ...thinking,
      sse({ id: "t", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] }),
      sse({ id: "t", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }),
      "data: [DONE]\n\n",
    ]);
  }
  const call = { index: 0, id: `call_${round}`, type: "function", function: { name: wireToolName(body, step.tool), arguments: JSON.stringify(step.args) } };
  return streamResponse([
    ...thinking,
    sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "", tool_calls: [call] }, finish_reason: null }] }),
    sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }),
    "data: [DONE]\n\n",
  ]);
}

function lowercaseHeaders(raw: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (raw instanceof Headers) raw.forEach((value, key) => (headers[key.toLowerCase()] = value));
  else for (const [key, value] of Object.entries((raw ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = String(value);
  return headers;
}

async function runSession(provider: ProviderId, model: string, reasoning: boolean): Promise<{ sessionId: string; requests: WireRequest[] }> {
  const requests: WireRequest[] = [];
  let turn = 0;
  let round = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as { url?: string }).url ?? input);
      const responsesWire = /\/responses(?:\?|$)/.test(url);
      if (!responsesWire && !url.includes("/chat/completions")) {
        return new Response(JSON.stringify({ data: [], models: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const headers = lowercaseHeaders(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(headers["x-clai-session"] ?? "").startsWith("preflight-")) {
        return responsesWire
          ? buildWireResponse("meta_responses", "stream", "answer", model)
          : streamResponse([
              sse({ id: "p", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
              "data: [DONE]\n\n",
            ]);
      }
      const steps = TURNS[turn]!.steps;
      const step = steps[Math.min(round, steps.length - 1)]!;
      round += 1;
      requests.push({
        headers,
        body,
        tools: JSON.stringify(body.tools ?? []),
        messages: promptItems(body),
      });
      if (responsesWire) return buildWireResponse("meta_responses", "stream", "tool" in step ? "tools" : "answer", model);
      return reply(step, round, reasoning, body);
    }),
  );
  const sessionId = `prefix-guard-${provider}`;
  const session = createSessionPolicy(sessionId);
  let history: ChatMessage[] = [];
  for (const [index, { prompt }] of TURNS.entries()) {
    turn = index;
    round = 0;
    await runAgentTurn(prompt, {
      provider,
      model,
      history,
      session,
      maxSteps: 6,
      toolCalling: "native",
      autoConfirm: true,
      ...(reasoning ? { thinking: { enabled: true, effort: "medium" as const } } : {}),
      onMessages: (messages) => {
        history = messages;
      },
    });
  }
  return { sessionId, requests };
}

function firstDivergence(previous: WireRequest, next: WireRequest): string {
  if (previous.tools !== next.tools) return "tools";
  const shared = Math.min(previous.messages.length, next.messages.length);
  for (let index = 0; index < previous.messages.length; index += 1) {
    if (index >= shared) return `message ${index} missing`;
    if (previous.messages[index] !== next.messages[index]) return `message ${index}`;
  }
  return "none";
}

function affinityValues(requests: readonly WireRequest[], read: (request: WireRequest) => unknown): Set<unknown> {
  return new Set(requests.map(read).filter((value) => value !== undefined));
}

beforeAll(async () => {
  updateConfig({ disableKeychain: true });
  for (const [provider] of ROUTES) await setProviderSecret(provider, "workos:prefix-guard-credential");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(ROUTES)("%s keeps its wire prefix across rounds and turns", (provider, model) => {
  it.each(provider === "cline" ? [false, true] : [false])(
    "extends the previous request byte for byte (reasoning replay %s)",
    async (reasoning) => {
      const { requests } = await runSession(provider, model, reasoning);
      expect(requests.length).toBeGreaterThanOrEqual(7);
      for (let index = 1; index < requests.length; index += 1) {
        expect(firstDivergence(requests[index - 1]!, requests[index]!)).toBe("none");
      }
    },
    60_000,
  );

  it("sends one stable cache affinity for the whole session", async () => {
    const { requests } = await runSession(provider, model, false);
    for (const read of [
      (request: WireRequest) => request.headers["x-task-id"],
      (request: WireRequest) => request.body.session_id,
      (request: WireRequest) => request.body.prompt_cache_key,
      (request: WireRequest) => request.body.prompt_cache_isolation_key,
    ]) {
      expect(affinityValues(requests, read).size).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

describe("cline cache affinity", () => {
  it("addresses every request to the session through the task header and a derived session key", async () => {
    const { sessionId, requests } = await runSession("cline", "cline-free/deepseek-v4.1-flash", false);
    expect(new Set(requests.map((request) => request.headers["x-task-id"]))).toEqual(new Set([sessionId]));
    const keys = new Set(requests.map((request) => request.body.session_id));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^clai-[0-9a-f]{40}$/);
  }, 60_000);
});
