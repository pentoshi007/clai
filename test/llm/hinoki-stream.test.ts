import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUsageLedger, usageCacheHitRate } from "../../src/app/controllers/session-usage-ledger.js";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { hinokiProvider, resetHinokiModelCatalogCache } from "../../src/llm/hinoki.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import type { ProviderStreamEvent } from "../../src/llm/stream-events.js";
import { formatSessionUsage } from "../../src/ui-core/rendering/format-usage.js";
import { AUTH, ENTRY, MODEL, REQUEST, TOOL, USAGE, json, sse, transport } from "./hinoki-fixtures.js";

beforeEach(() => {
  resetHinokiModelCatalogCache();
  resetReasoningKnowledge();
  clearModelCatalogFacts();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hinoki streaming and usage", () => {
  it("streams fragmented Unicode reasoning, text and interleaved tool calls with trailing usage", async () => {
    const { generations } = transport(() => sse([
      { choices: [{ delta: { reasoning_content: "Inspect 🧪 " } }] },
      { choices: [{ delta: { reasoning_content: "the files" } }] },
      { choices: [{ delta: { content: "Reading" } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "fs_read", arguments: '{"path":' } },
        { index: 1, id: "call_2", type: "function", function: { name: "fs_read", arguments: '{"path":"second.md"}' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: USAGE },
    ], true, true));
    const events: ProviderStreamEvent[] = [];
    const tokens: string[] = [];
    const toolDelta = vi.fn();
    const result = await tryStreamOnce(hinokiProvider, "hinoki", {
      ...REQUEST, tools: [TOOL], thinking: { enabled: true, effort: "max" },
      onStreamEvent: (event) => events.push(event), onToolCallDelta: toolDelta,
    }, MODEL, AUTH, (token) => tokens.push(token), undefined, "initial");
    expect(tokens.join("")).toBe("Reading");
    expect(result.reasoningBlock?.text).toBe("Inspect 🧪 the files");
    expect(events.filter((event) => event.type === "reasoning_delta")).toEqual([
      { type: "reasoning_delta", text: "Inspect 🧪 " }, { type: "reasoning_delta", text: "the files" },
    ]);
    expect(result.toolCalls?.map(({ id, name, args }) => ({ id, name, args }))).toEqual([
      { id: "call_1", name: "fs.read", args: { path: "README.md" } },
      { id: "call_2", name: "fs.read", args: { path: "second.md" } },
    ]);
    expect(toolDelta).toHaveBeenCalled();
    expect(events.filter((event) => event.type === "tool_call_completed")).toHaveLength(2);
    expect(events.filter((event) => event.type === "provider_terminal")).toHaveLength(1);
    expect(result.usage).toMatchObject({ promptTokens: 120, completionTokens: 30, cachedPromptTokens: 80, cacheCreationTokens: 12, reasoningTokens: 10 });
    expect(JSON.parse(generations[0]!.body)).toMatchObject({ stream: true, stream_options: { include_usage: true }, reasoning_effort: "max" });
    const ledger = new SessionUsageLedger();
    ledger.record(result.usage!, "hinoki", MODEL, result.api);
    const body = formatSessionUsage(ledger.report(), { sessionId: "hinoki-usage" });
    expect(body).toContain("Hinoki / hinoki-offensive");
    expect(body).toContain("chat-completions | 1 | 120 | 30 | 150 | 80 | 66.7%");
    expect(body).toContain("reasoning 10");
    expect(body).toContain("cache write 12");
    expect(usageCacheHitRate(ledger.report().totals)).toBeCloseTo(2 / 3);
  });

  it("handles reasoning aliases and JSON responses to a streaming request", async () => {
    transport(() => json({ choices: [{ message: { content: "Answer", reasoning: "Analyze first" }, finish_reason: "stop" }], usage: USAGE }));
    const events: ProviderStreamEvent[] = [];
    const result = await hinokiProvider.stream!({ ...REQUEST, onStreamEvent: (event) => events.push(event) }, AUTH, () => {});
    expect(result).toMatchObject({ text: "Answer", reasoningBlock: { text: "Analyze first" }, usage: { reasoningTokens: 10 } });
    expect(events.some((event) => event.type === "reasoning_delta")).toBe(true);
  });

  it("reports hidden reasoning and explicit zero cache hits without fabricating visible reasoning", async () => {
    transport(() => sse([
      { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 20 } } },
    ]));
    const result = await hinokiProvider.stream!(REQUEST, AUTH, () => {});
    const ledger = new SessionUsageLedger();
    ledger.record(result.usage!, "hinoki", MODEL, result.api);
    const body = formatSessionUsage(ledger.report(), { sessionId: "hidden" });
    expect(body).toContain("reasoning 20");
    expect(body).toContain("0.0%");
    expect(ledger.report().totals.completionTokens).toBe(30);
  });

  it("leaves missing cache and reasoning counters unknown and preserves persisted usage", async () => {
    transport(() => sse([{ choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]));
    const result = await hinokiProvider.stream!(REQUEST, AUTH, () => {});
    expect(result.usage?.cachedPromptTokens).toBeUndefined();
    expect(result.usage?.reasoningTokens).toBeUndefined();
    const ledger = new SessionUsageLedger();
    ledger.record(result.usage!, "hinoki", MODEL, result.api);
    const restored = new SessionUsageLedger();
    restored.restore(JSON.parse(JSON.stringify(ledger.persist())));
    expect(restored.report().totals).toEqual(ledger.report().totals);
    expect(usageCacheHitRate(restored.report().totals)).toBeUndefined();
    expect(formatSessionUsage(restored.report(), { sessionId: "restored" })).not.toContain("0.0%");
  });

  it("accepts DONE markers and exposes budget truncation", async () => {
    transport(() => sse([{ choices: [{ delta: { content: "Answer" } }] }]));
    expect((await hinokiProvider.stream!(REQUEST, AUTH, () => {})).text).toBe("Answer");
    transport(() => sse([{ choices: [{ delta: { content: "Partial" }, finish_reason: "length" }] }]));
    expect(await hinokiProvider.stream!(REQUEST, AUTH, () => {})).toMatchObject({ text: "Partial", finishReason: "length" });
  });

  it("rejects premature EOF and provider stream errors", async () => {
    transport(() => sse([{ choices: [{ delta: { content: "Partial" } }] }], false));
    await expect(hinokiProvider.stream!(REQUEST, AUTH, () => {})).rejects.toThrow(/without terminal proof/);
    transport(() => sse([{ error: { message: "backend unavailable", code: "server_error" } }], false));
    await expect(hinokiProvider.stream!(REQUEST, AUTH, () => {})).rejects.toThrow(/backend unavailable/);
  });

  it("cancels an active stream and releases its reader", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    transport(() => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } }));
    await expect(hinokiProvider.stream!({ ...REQUEST, signal: controller.signal }, AUTH, () => controller.abort())).rejects.toThrow(/abort/i);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a discovery waiter without cancelling another request sharing the lookup", async () => {
    let finish: (response: Response) => void = () => { throw new Error("lookup not started"); };
    const { generations, fetchMock } = transport(() => json({ choices: [{ message: { content: "Answer" }, finish_reason: "stop" }] }),
      () => new Promise<Response>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const first = hinokiProvider.complete({ ...REQUEST, signal: controller.signal }, AUTH);
    const second = hinokiProvider.complete(REQUEST, AUTH);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(first).rejects.toThrow("cancelled");
    expect(generations).toHaveLength(0);
    finish(json({ data: [ENTRY] }));
    expect((await second).text).toBe("Answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
