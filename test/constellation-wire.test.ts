import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ToolDefinition } from "../src/types.js";
import { constellationProvider, resetConstellationModelCatalogCache } from "../src/llm/constellation.js";
import { resetReasoningKnowledge } from "../src/llm/capabilities.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";

const MODEL = "openai/gpt-5-4-mini";
const auth = { apiKey: "sk-gw-wiretestcredential" };
const tool: ToolDefinition = {
  name: "fs.read", wireName: "fs_read", description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
interface Body {
  messages: Array<Record<string, unknown>>;
  tools?: unknown[];
  reasoning_effort?: string;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  max_completion_tokens?: number;
  max_tokens?: number;
}
function catalog(): Response {
  return Response.json({ data: [{ id: MODEL, tags: ["vision", "reasoning", "tool-use"], context_window: 400_000, max_tokens: 128_000, supported_reasoning_efforts: ["low", "high"] }] });
}
function answer(): Response {
  return Response.json({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 700 }, cache_creation_input_tokens: 100, completion_tokens_details: { reasoning_tokens: 5 } },
  });
}
function capture(body: RequestInit | undefined): Body {
  return JSON.parse(String(body?.body)) as Body;
}

beforeEach(() => {
  resetConstellationModelCatalogCache();
  resetReasoningKnowledge();
});
afterEach(() => vi.unstubAllGlobals());

describe("Constellation chat transport", () => {
  it("honors a configured endpoint override for catalog and generation requests", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).endsWith("/models")) return catalog();
      return answer();
    });
    vi.stubGlobal("fetch", fetchMock);
    const overridden = { ...auth, baseUrl: "https://mirror.example.test/v1/" };
    await constellationProvider.listModels!(overridden);
    await constellationProvider.complete!({
      messages: [{ role: "user", content: "hi" }],
      thinking: { enabled: true, effort: "low" },
    }, overridden);
    expect(urls).toEqual([
      "https://mirror.example.test/v1/models",
      "https://mirror.example.test/v1/chat/completions",
    ]);
    expect(capture(fetchMock.mock.calls[1]?.[1]).reasoning_effort).toBe("low");
  });

  it("preserves cacheable prefixes and complete tool history across turns without protocol probes", async () => {
    const bodies: Body[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return catalog();
      expect(String(url)).toBe("https://gateway.constellationgate.ai/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${auth.apiKey}`);
      bodies.push(capture(init));
      return answer();
    });
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [{ role: "system", content: "stable instructions" }, { role: "user", content: "Read the file" }];
    const first = await withSessionAffinity("constellation-cache-test", () => constellationProvider.complete({ model: MODEL, messages, tools: [tool], thinking: { enabled: true, effort: "max" }, maxTokens: 200_000 }, auth));
    const toolOutput = "x".repeat(20_000);
    await withSessionAffinity("constellation-cache-test", () => constellationProvider.complete({ model: MODEL, messages: [...messages,
      { role: "assistant", content: "", toolCalls: [{ id: "call1", name: "fs.read", args: { path: "/tmp/file" } }] },
      { role: "tool", toolCallId: "call1", name: "fs.read", content: toolOutput },
      { role: "user", content: "Continue" },
    ], tools: [tool], thinking: { enabled: true, effort: "max" } }, auth));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages.slice(0, 2)).toEqual(bodies[0]?.messages);
    expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    expect(bodies[1]?.messages.find((m) => m.role === "tool")?.content).toBe(toolOutput);
    expect(bodies[0]?.reasoning_effort).toBe("high");
    expect(bodies[0]?.max_completion_tokens).toBe(128_000);
    expect(first.usage).toMatchObject({ promptTokens: 1000, completionTokens: 20, cachedPromptTokens: 700, cacheCreationTokens: 100, reasoningTokens: 5, exact: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("streams content, partial tools, terminal usage and reasoning separately", async () => {
    const events = [
      { choices: [{ delta: { reasoning_content: "think" } }] },
      { choices: [{ delta: { content: "answer" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "fs_read", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/a"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 }, cache_creation_input_tokens: 10 } },
    ];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return catalog();
      expect(capture(init).stream_options).toEqual({ include_usage: true });
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onToken = vi.fn();
    const onToolCallDelta = vi.fn();
    const result = await constellationProvider.stream!({ model: MODEL, messages: [{ role: "user", content: "read" }], tools: [tool], onToolCallDelta }, auth, onToken);
    expect(result.text).toBe("answer");
    expect(result.reasoningBlock?.text).toBe("think");
    expect(onToken).toHaveBeenCalledWith("answer");
    expect(onToolCallDelta).toHaveBeenCalled();
    expect(result.toolCalls).toMatchObject([{ id: "call1", name: "fs.read", args: { path: "/tmp/a" } }]);
    expect(result.usage).toMatchObject({ promptTokens: 100, cachedPromptTokens: 80, cacheCreationTokens: 10 });
  });

  it("does not send a generation without credentials or after cancellation", async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetchMock);
    await expect(constellationProvider.complete({ messages: [] }, {})).rejects.toThrow("API key is required");
    const controller = new AbortController();
    controller.abort();
    await expect(constellationProvider.complete({ messages: [], signal: controller.signal }, auth)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels promptly while a coalesced catalog request is pending", async () => {
    let release: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const request = constellationProvider.complete({ messages: [], signal: controller.signal }, auth);
    controller.abort();
    await expect(request).rejects.toThrow();
    release(catalog());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
