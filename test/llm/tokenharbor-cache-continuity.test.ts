import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionUsageLedger, usageCacheHitRate } from "../../src/app/controllers/session-usage-ledger.js";
import { TOKENHARBOR_CACHE_CONTROL_HEADER, tokenharborProvider } from "../../src/llm/tokenharbor.js";
import type { ChatMessage, CompletionRequest, ToolDefinition } from "../../src/types.js";

const KEY = "thk_live_cache_continuity_fixture";
const MODEL = "claude-sonnet-5.5";
const TOOL: ToolDefinition = {
  name: "fs.read",
  wireName: "fs_read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

type WireBlock = { type: string; text?: string; cache_control?: { type: string } };
type WireMessage = { role: string; content: string | WireBlock[] | null; tool_call_id?: string };
type WireBody = { messages: WireMessage[]; tools: object[]; prompt_cache_key?: string };

function mockTransport(usage: Record<string, number | object> = {}) {
  const bodies: WireBody[] = [];
  const headers: Headers[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as WireBody);
    headers.push(new Headers(init.headers));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
      usage,
    }), { headers: { "content-type": "application/json" } });
  }));
  return { bodies, headers };
}

function hasMark(message: WireMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.cache_control?.type === "ephemeral");
}

function appendToolTurn(messages: ChatMessage[], label: string): void {
  const calls = Array.from({ length: 24 }, (_, index) => ({
    id: `call_${label}_${index}`,
    name: "fs.read",
    args: { path: `${label}-${index}.ts` },
  }));
  messages.push({ role: "assistant", content: "", toolCalls: calls });
  for (const call of calls) {
    messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: `Contents of ${call.args.path}`, ok: true });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Token Harbor cache continuity", () => {
  it("retains a lookup mark at the previous prompt boundary across large parallel tool batches", async () => {
    const { bodies, headers } = mockTransport();
    const messages: ChatMessage[] = [
      { role: "system", content: "Stable instructions. ".repeat(500) },
      { role: "user", content: "Inspect the project" },
      { role: "system", content: "REQUEST CONTEXT\nturn one" },
    ];
    for (let turn = 0; turn < 4; turn += 1) {
      const snapshot = JSON.stringify(messages);
      await tokenharborProvider.complete({ model: MODEL, messages, tools: [TOOL] }, { apiKey: KEY });
      expect(JSON.stringify(messages)).toBe(snapshot);
      const current = bodies[turn]!;
      const marks = current.messages.flatMap((message) => Array.isArray(message.content)
        ? message.content.filter((block) => block.cache_control)
        : []);
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.length).toBeLessThanOrEqual(4);
      expect(hasMark(current.messages[0]!)).toBe(true);
      expect(hasMark(current.messages.at(-1)!)).toBe(true);
      expect(current).not.toHaveProperty("prompt_cache_key");
      if (turn > 0) {
        const previous = bodies[turn - 1]!;
        expect(current.messages.length - previous.messages.length).toBe(25);
        const boundary = current.messages[previous.messages.length - 1]!;
        expect(hasMark(boundary)).toBe(true);
        expect(boundary).toEqual(previous.messages.at(-1));
        expect(current.tools).toEqual(previous.tools);
      }
      expect(headers[turn]!.get(TOKENHARBOR_CACHE_CONTROL_HEADER)).toBe("bypass");
      appendToolTurn(messages, String(turn));
    }
  });

  it("keeps the previous user-turn boundary marked after a context update", async () => {
    const { bodies } = mockTransport();
    const messages: ChatMessage[] = [
      { role: "system", content: "Stable instructions" },
      { role: "user", content: "First question" },
      { role: "system", content: "REQUEST CONTEXT\nturn one" },
    ];
    await tokenharborProvider.complete({ model: MODEL, messages }, { apiKey: KEY });
    const previous = bodies[0]!.messages.at(-1)!;
    messages.push(
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Next question" },
      { role: "system", content: "REQUEST CONTEXT\nturn two" },
    );
    await tokenharborProvider.complete({ model: MODEL, messages }, { apiKey: KEY });
    const boundary = bodies[1]!.messages[2]!;
    expect(boundary).toEqual(previous);
    expect(hasMark(boundary)).toBe(true);
  });

  it.each([
    {
      name: "Anthropic counters",
      usage: { input_tokens: 812, output_tokens: 20, cache_creation_input_tokens: 11_702, cache_read_input_tokens: 20_000 },
    },
    {
      name: "OpenAI counters with Anthropic cache fields",
      usage: { prompt_tokens: 32_514, completion_tokens: 20, cache_creation_input_tokens: 11_702, cache_read_input_tokens: 20_000 },
    },
    {
      name: "OpenAI nested cache counters",
      usage: { prompt_tokens: 32_514, completion_tokens: 20, cache_creation_input_tokens: 11_702, prompt_tokens_details: { cached_tokens: 20_000 } },
    },
  ])("normalizes $name without undercounting the hit-rate denominator", async ({ usage }) => {
    mockTransport(usage);
    const request: CompletionRequest = { model: MODEL, messages: [{ role: "user", content: "Continue" }] };
    const result = await tokenharborProvider.complete(request, { apiKey: KEY });
    expect(result.usage).toMatchObject({ promptTokens: 32_514, cachedPromptTokens: 20_000, cacheCreationTokens: 11_702, totalTokens: 32_534 });
    const ledger = new SessionUsageLedger();
    ledger.record(result.usage!, "tokenharbor", MODEL);
    expect(usageCacheHitRate(ledger.report().totals)).toBeCloseTo(20_000 / 32_514);
  });
});
