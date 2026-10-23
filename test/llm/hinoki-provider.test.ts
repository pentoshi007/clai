import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearModelCatalogFacts, clearModelVisionCapabilities, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { hinokiProvider, resetHinokiModelCatalogCache } from "../../src/llm/hinoki.js";
import { ProviderError } from "../../src/llm/http.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { AUTH, ENTRY, MODEL, REQUEST, TOOL, USAGE, completion, json, transport } from "./hinoki-fixtures.js";

beforeEach(() => {
  resetHinokiModelCatalogCache();
  resetReasoningKnowledge();
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Hinoki requests", () => {
  it("sends a stateless Chat Completions request and parses all usage counters", async () => {
    const { generations } = transport();
    const result = await hinokiProvider.complete(REQUEST, AUTH);
    expect(generations[0]?.url).toBe("https://inference.hinoki.security/v1/chat/completions");
    expect(generations[0]?.headers.get("authorization")).toBe(`Bearer ${AUTH.apiKey}`);
    expect(result).toMatchObject({ provider: "hinoki", model: MODEL, api: "chat-completions", text: "Answer",
      reasoningBlock: { text: "Consider the evidence" }, usage: {
        promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedPromptTokens: 80,
        cacheCreationTokens: 12, reasoningTokens: 10, exact: true,
      } });
    for (const field of ["previous_response_id", "store", "session_id", "cache_control"]) expect(generations[0]?.body).not.toContain(`"${field}"`);
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const)("preserves accepted effort %s without changing the caller", async (effort) => {
    const { generations } = transport();
    const thinking = { enabled: effort !== "none", effort };
    await hinokiProvider.complete({ ...REQUEST, thinking }, AUTH);
    expect(JSON.parse(generations[0]!.body)).toMatchObject({ reasoning_effort: effort });
    expect(thinking).toEqual({ enabled: effort !== "none", effort });
  });

  it("uses dynamic effort and output limits rather than the fallback vocabulary", async () => {
    const { generations } = transport(completion, () => json({ data: [{ ...ENTRY, max_output_tokens: 2048,
      reasoning: { mandatory: true, supported_efforts: ["low", "high"] },
    }] }));
    await hinokiProvider.complete({ ...REQUEST, maxTokens: 50_000, thinking: { enabled: true, effort: "max" } }, AUTH);
    expect(JSON.parse(generations[0]!.body)).toMatchObject({ reasoning_effort: "high", max_tokens: 2048 });
  });

  it("serializes tools, named choices, parallel calls and image input", async () => {
    const { generations } = transport(() => json({ choices: [{ message: {
      content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "fs_read", arguments: '{"path":"README.md"}' } }],
    }, finish_reason: "stop" }], usage: USAGE }));
    const result = await hinokiProvider.complete({ ...REQUEST, tools: [TOOL],
      toolChoice: { type: "function", name: "fs.read" }, parallelToolCalls: true,
      messages: [{ role: "user", content: "Inspect", images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }] }],
    }, AUTH);
    expect(JSON.parse(generations[0]!.body)).toMatchObject({
      messages: [{ role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] }],
      tools: [{ type: "function", function: { name: "fs_read" } }],
      tool_choice: { type: "function", function: { name: "fs_read" } }, parallel_tool_calls: true,
    });
    expect(result.toolCalls).toEqual([{ id: "read-1", name: "fs.read", args: { path: "README.md" }, rawArguments: '{"path":"README.md"}' }]);
  });

  it("suppresses tools, images and effort controls when metadata denies them", async () => {
    const { generations } = transport(completion, () => json({ data: [{ ...ENTRY,
      reasoning: false, capabilities: { vision: false, function_calling: false },
    }] }));
    await hinokiProvider.complete({ ...REQUEST, tools: [TOOL], thinking: { enabled: true, effort: "max" },
      messages: [{ role: "user", content: "Inspect", images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }] }],
    }, AUTH);
    const body = generations[0]!.body;
    for (const field of ["tools", "tool_choice", "reasoning_effort", "image_url"]) expect(body).not.toContain(`"${field}"`);
    expect(body).toContain("Image input unavailable");
  });

  it("round-trips native tool and compatible reasoning history without saved response IDs", async () => {
    const { generations } = transport(() => json({ choices: [{ message: {
      content: "", reasoning_content: "Consider the file", tool_calls: [{ id: "call_read", type: "function", function: { name: "fs_read", arguments: '{"path":"README.md"}' } }],
    }, finish_reason: "tool_calls" }] }));
    const result = await hinokiProvider.complete({ ...REQUEST, tools: [TOOL] }, AUTH);
    await hinokiProvider.complete({ ...REQUEST, tools: [TOOL], messages: [...REQUEST.messages,
      { role: "assistant", content: "", toolCalls: result.toolCalls, reasoningArtifacts: result.reasoningArtifacts },
      { role: "tool", toolCallId: "call_read", name: "fs.read", content: "Contents", ok: true },
    ] }, AUTH);
    expect(JSON.parse(generations[1]!.body)).toMatchObject({ messages: [...REQUEST.messages,
      { role: "assistant", reasoning_content: "Consider the file", tool_calls: [{ id: "call_read", function: { name: "fs_read" } }] },
      { role: "tool", tool_call_id: "call_read", content: "Contents" },
    ] });
    expect(generations[1]?.body).not.toContain("previous_response_id");
  });

  it("preserves byte-identical message/tool prefixes and session affinity across turns and keys", async () => {
    const { generations } = transport();
    await withSessionAffinity("hinoki-cache", async () => {
      await hinokiProvider.complete({ ...REQUEST, tools: [TOOL], maxTokens: 1024 }, AUTH);
      await hinokiProvider.complete({ ...REQUEST, tools: [TOOL], maxTokens: 2048, messages: [
        ...REQUEST.messages, { role: "assistant", content: "Answer" }, { role: "user", content: "Next" },
      ] }, { apiKey: "hinoki-another-credential" });
    });
    const first: { messages: unknown[]; tools: unknown[]; prompt_cache_key: string } = JSON.parse(generations[0]!.body);
    const second: typeof first = JSON.parse(generations[1]!.body);
    expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(first.prompt_cache_key).not.toContain("hinoki-cache");
    await withSessionAffinity("hinoki-cache:subagent:1", () => hinokiProvider.complete(REQUEST, AUTH));
    const child: typeof first = JSON.parse(generations[2]!.body);
    expect(child.prompt_cache_key).not.toBe(first.prompt_cache_key);
  });

  it("honors explicit endpoints before environment overrides", async () => {
    vi.stubEnv("HINOKI_BASE_URL", "https://regional.example/");
    const { generations } = transport();
    await hinokiProvider.complete(REQUEST, AUTH);
    await hinokiProvider.complete(REQUEST, { ...AUTH, baseUrl: "https://explicit.example/v1/responses" });
    expect(generations.map(({ url }) => url)).toEqual([
      "https://regional.example/v1/chat/completions", "https://explicit.example/v1/chat/completions",
    ]);
  });

  it("preserves typed errors and provider retry hints for shared key rotation", async () => {
    transport(() => new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { "retry-after": "7" } }));
    await expect(hinokiProvider.complete(REQUEST, AUTH)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 });
    transport(() => json({ error: { message: "Unavailable" } }, 503));
    await expect(hinokiProvider.complete(REQUEST, AUTH)).rejects.toBeInstanceOf(ProviderError);
  });

  it("does not send any request without a credential or after cancellation", async () => {
    const { fetchMock } = transport();
    await expect(hinokiProvider.complete(REQUEST, {})).rejects.toThrow("Hinoki API key is required");
    await expect(hinokiProvider.complete({ ...REQUEST, signal: AbortSignal.abort() }, AUTH)).rejects.toThrow(/abort/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
