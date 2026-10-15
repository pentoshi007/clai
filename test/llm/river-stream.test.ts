import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { riverProvider } from "../../src/llm/river.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import type { ProviderStreamEvent } from "../../src/llm/stream-events.js";
import { json, REQUEST, sse, TOOL, transport, USAGE } from "./river-fixtures.js";

let sequence = 0;
let apiKey: string;
beforeEach(() => {
  apiKey = `rv_stream_fixture_${++sequence}`;
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});

describe("River streaming and history", () => {
  it("streams fragmented UTF-8 reasoning, answer, tools, usage and terminal events separately", async () => {
    const { generations } = transport(() => sse([
      { choices: [{ delta: { reasoning_content: "Inspect 🧪 " } }] },
      { choices: [{ delta: { reasoning_content: "the file" } }] },
      { choices: [{ delta: { content: "Reading" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "fs_read", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: USAGE },
    ], true, true));
    const events: ProviderStreamEvent[] = [];
    const tokens: string[] = [];
    const toolDelta = vi.fn();
    const result = await tryStreamOnce(riverProvider, "river", {
      ...REQUEST, tools: [TOOL], thinking: { enabled: true, effort: "max" },
      onStreamEvent: (event) => events.push(event), onToolCallDelta: toolDelta,
    }, REQUEST.model!, { apiKey }, (token) => tokens.push(token), undefined, "initial");
    expect(tokens.join("")).toBe("Reading");
    expect(result.reasoningBlock?.text).toBe("Inspect 🧪 the file");
    expect(events.filter((event) => event.type === "reasoning_delta")).toEqual([
      { type: "reasoning_delta", text: "Inspect 🧪 " }, { type: "reasoning_delta", text: "the file" },
    ]);
    expect(result.toolCalls).toEqual([{ id: "call_read", name: "fs.read", args: { path: "README.md" }, rawArguments: '{"path":"README.md"}' }]);
    expect(toolDelta).toHaveBeenCalled();
    expect(events.some((event) => event.type === "tool_call_completed")).toBe(true);
    expect(events.filter((event) => event.type === "provider_terminal")).toHaveLength(1);
    expect(result.usage).toMatchObject({ cachedPromptTokens: 80, reasoningTokens: 10, totalTokens: 150 });
    expect(JSON.parse(generations[0]!.body)).toMatchObject({ stream: true, reasoning_effort: "max" });
    expect(generations[0]!.body).not.toContain("stream_options");
  });

  it("accepts a DONE-only completion marker and reports truncated output", async () => {
    transport(() => sse([{ choices: [{ delta: { content: "Answer" } }] }]));
    expect((await riverProvider.stream!(REQUEST, { apiKey }, () => {})).text).toBe("Answer");
    transport(() => sse([{ choices: [{ delta: { content: "Budget exhausted" }, finish_reason: "length" }], usage: USAGE }]));
    expect(await riverProvider.stream!(REQUEST, { apiKey }, () => {})).toMatchObject({ finishReason: "length", text: "Budget exhausted" });
  });

  it("round-trips matching reasoning and tool history through the shared artifact machinery", async () => {
    const { generations } = transport(() => json({ choices: [{ message: {
      content: "", reasoning_content: "Consider the file", tool_calls: [{
        id: "call_read", type: "function", function: { name: "fs_read", arguments: '{"path":"README.md"}' },
      }],
    }, finish_reason: "tool_calls" }] }));
    const request = { ...REQUEST, tools: [TOOL], thinking: { enabled: true, effort: "high" as const } };
    const result = await riverProvider.complete(request, { apiKey });
    expect(result.reasoningArtifacts?.length).toBeGreaterThan(0);
    await riverProvider.complete({ ...request, messages: [
      ...REQUEST.messages,
      { role: "assistant", content: "", toolCalls: result.toolCalls, reasoningArtifacts: result.reasoningArtifacts },
      { role: "tool", toolCallId: "call_read", name: "fs.read", content: "Contents", ok: true },
    ] }, { apiKey });
    expect(JSON.parse(generations[1]!.body)).toMatchObject({ messages: [
      ...REQUEST.messages,
      { role: "assistant", reasoning_content: "Consider the file", tool_calls: [{ id: "call_read", function: { name: "fs_read" } }] },
      { role: "tool", tool_call_id: "call_read", content: "Contents" },
    ] });
  });

  it("aborts an active stream and cancels its reader", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    transport(() => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } }));
    await expect(riverProvider.stream!({ ...REQUEST, signal: controller.signal }, { apiKey }, () => controller.abort())).rejects.toThrow(/abort/i);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels during discovery without launching a generation", async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = riverProvider.stream!({ ...REQUEST, signal: controller.signal }, { apiKey }, () => {});
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toThrow("cancelled");
    finish?.(json({ data: [] }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces stream errors without replaying the request", async () => {
    const { fetchMock } = transport(() => sse([{ error: { message: "backend unavailable", code: "server_error" } }], false));
    await expect(riverProvider.stream!(REQUEST, { apiKey }, () => {})).rejects.toThrow(/backend unavailable/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
