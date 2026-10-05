import { afterEach, describe, expect, it, vi } from "vitest";
import { qoderProvider } from "../src/llm/qoder/qoder.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import type { ProviderStreamEvent } from "../src/llm/stream-events.js";
import { reasoningWireKey } from "../src/llm/routing/attempt-request.js";
import type { ChatMessage, NativeToolCall, ToolDefinition } from "../src/types.js";

vi.mock("../src/llm/qoder/qoder-signer.js", () => ({
  QoderSigner: {
    create: async () => ({
      prepareInfer: ({ body }: { body: string }) => ({ url: "https://test.invalid/inference", headers: {}, body }),
      free: () => {},
    }),
  },
}));

const auth = {
  apiKey: JSON.stringify({
    uid: "fixture-user", accessToken: "fixture-access", expireTime: 4_000_000_000,
    encryptUserInfo: "fixture-user-info", key: "fixture-key", machineId: "fixture-machine",
    machineCode: "fixture-code", machineToken: "fixture-token",
  }),
};

function response(chunks: object[], fragmented = false): Response {
  const frames = chunks.map((body) => `data: ${JSON.stringify({ body: JSON.stringify(body), statusCodeValue: 200 })}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(`${frames}data: [DONE]\r\n\r\n`);
  return new Response(new ReadableStream({
    start(controller) {
      if (fragmented) {
        for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      } else controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("Qoder reasoning and request continuity", () => {
  it.each(["minimal", "low", "medium", "high", "xhigh", "max", "none"] as const)("sends the selected %s effort", async (effort) => {
    const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => response([{ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }]));
    vi.stubGlobal("fetch", fetcher);
    await qoderProvider.complete({ messages: [{ role: "user", content: "question" }], thinking: { enabled: effort !== "none", effort } }, auth);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.parameters).toMatchObject({ reasoning_effort: effort, enable_thinking: effort !== "none" });
    expect(body.model_config.is_reasoning).toBe(effort !== "none");
    expect(body.chat_context.extra.modelConfig.is_reasoning).toBe(effort !== "none");
  });

  it("routes fragmented reasoning to thinking events and preserves cache usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([
      { choices: [{ delta: { reasoning_content: "analysis 中" } }] },
      { choices: [{ delta: { reasoning: " continuation" } }] },
      { choices: [{ delta: { content: "visible answer" }, finish_reason: "length" }],
        usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 20 } } },
    ], true)));
    const events: ProviderStreamEvent[] = [];
    const onToken = vi.fn();
    const result = await qoderProvider.stream!({ messages: [{ role: "user", content: "question" }],
      onStreamEvent: (event) => events.push(event) }, auth, onToken);
    expect(events.filter((event) => event.type === "reasoning_delta")).toEqual([{ type: "reasoning_delta", text: "analysis 中" }, { type: "reasoning_delta", text: " continuation" }]);
    expect(onToken).toHaveBeenCalledExactlyOnceWith("visible answer");
    expect(result).toMatchObject({ text: "visible answer", reasoningBlock: { text: "analysis 中 continuation" }, finishReason: "length",
      usage: { promptTokens: 100, completionTokens: 30, cachedPromptTokens: 80, reasoningTokens: 20, reasoningObserved: true } });
  });

  it("keeps completed reasoning separately from the answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ choices: [{ delta: { thinking: "thought", content: "answer" }, finish_reason: "stop" }] }])));
    const result = await qoderProvider.complete({ messages: [{ role: "user", content: "question" }] }, auth);
    expect(result.text).toBe("answer");
    expect(result.reasoningBlock?.text).toBe("thought");
  });

  it("preserves session affinity and the previous message prefix across requests", async () => {
    const bodies: Array<{ session_id: string; request_id: string; messages: unknown[]; system: unknown[] }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response([{ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }]);
    }));
    const messages = [{ role: "system" as const, content: "keep the original system instructions" },
      { role: "user" as const, content: "first question" }];
    await withSessionAffinity("session-a", () => qoderProvider.complete({ messages }, auth));
    await withSessionAffinity("session-a", () => qoderProvider.complete({ messages: [...messages, { role: "assistant", content: "answer" }, { role: "user", content: "follow-up" }] }, auth));
    await withSessionAffinity("session-b", () => qoderProvider.complete({ messages }, auth));
    expect(bodies[0]!.session_id).toBe(bodies[1]!.session_id);
    expect(bodies[2]!.session_id).not.toBe(bodies[0]!.session_id);
    expect(bodies[0]!.session_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/);
    expect(bodies[1]!.messages.slice(0, messages.length)).toEqual(bodies[0]!.messages);
    expect(bodies[0]!.messages[0]).toEqual(messages[0]);
    expect(bodies[0]!.system).toEqual([{ type: "text", text: messages[0]!.content }]);
    expect(bodies[1]!.request_id).not.toBe(bodies[0]!.request_id);
  });

  it("does not swallow a consumer failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ choices: [{ delta: { content: "answer" } }] }])));
    await expect(qoderProvider.stream!({ messages: [{ role: "user", content: "question" }] }, auth,
      () => { throw new Error("consumer failed"); })).rejects.toThrow("consumer failed");
  });

  it("keeps Qoder effort fallback keys distinct and removes rejected controls", async () => {
    expect(reasoningWireKey({ enabled: true, effort: "xhigh" }, "qoder", "fixture-qoder", "qoder"))
      .not.toBe(reasoningWireKey({ enabled: true, effort: "high" }, "qoder", "fixture-qoder", "qoder"));
    const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => response([{ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }]));
    vi.stubGlobal("fetch", fetcher);
    await qoderProvider.complete({ messages: [{ role: "user", content: "question" }] }, auth);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.parameters.reasoning_effort).toBeUndefined();
    expect(body.parameters.enable_thinking).toBeUndefined();
  });

  it("sends native tools, retains tool history and images, and accumulates tool arguments", async () => {
    const tools: ToolDefinition[] = [{ name: "fs.read", wireName: "fs_read", description: "read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const previousCall: NativeToolCall = { id: "previous", name: "fs.read", args: { path: "first.ts" } };
    const messages: ChatMessage[] = [
      { role: "system", content: "Original instructions" },
      { role: "user", content: "Read a file" },
      { role: "assistant", content: "", toolCalls: [previousCall] },
      { role: "tool", content: "previous output", toolCallId: "previous", name: "fs.read" },
      { role: "user", content: "Inspect this image too", images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }] },
    ];
    const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => response([
      { choices: [{ delta: { reasoning_content: "inspect the next file" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "next", function: { name: "fs_read", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"next.ts"}' } }] }, finish_reason: "tool_calls" }] },
    ], true));
    vi.stubGlobal("fetch", fetcher);
    const onToolCallDelta = vi.fn();
    const result = await qoderProvider.stream!({ messages, tools, toolChoice: { type: "function", name: "fs.read" }, parallelToolCalls: false,
      thinking: { enabled: true, effort: "xhigh" }, onToolCallDelta, onStreamEvent: () => {} }, auth, () => {});
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "fs_read", description: tools[0]!.description, parameters: tools[0]!.parameters } });
    expect(body.parameters).toMatchObject({ tool_choice: { type: "function", function: { name: "fs_read" } }, parallel_tool_calls: false });
    expect(body.messages[2].tool_calls[0]).toMatchObject({ id: "previous", function: { name: "fs_read", arguments: '{"path":"first.ts"}' } });
    expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "previous", content: "previous output" });
    expect(body.messages[4].content[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } });
    expect(onToolCallDelta).toHaveBeenCalledWith(expect.objectContaining({ id: "next", name: "fs.read" }));
    expect(result.toolCalls).toEqual([expect.objectContaining({ id: "next", name: "fs.read", args: { path: "next.ts" } })]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.reasoningArtifacts?.[0]).toMatchObject({ provenance: { provider: "qoder" }, replay: { persistence: "tool-turn" } });
  });
});
