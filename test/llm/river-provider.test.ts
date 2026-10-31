import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReasoningEffort } from "../../src/types.js";
import { clearModelCatalogFacts, clearModelVisionCapabilities, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { ProviderError } from "../../src/llm/http.js";
import { getDefaultModel, getEnvVar, normalizeProvider, redactSecrets } from "../../src/llm/provider.js";
import { getProvider } from "../../src/llm/routing/provider-selection.js";
import { riverProvider } from "../../src/llm/river.js";
import { RIVER_DEFAULT_MODEL, RIVER_GLM_MODEL } from "../../src/llm/river-models.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { completion, json, REQUEST, sse, TOOL, transport, USAGE } from "./river-fixtures.js";

let sequence = 0;
let apiKey: string;
beforeEach(() => {
  apiKey = `rv_fixture_${++sequence}`;
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
});

describe("River provider", () => {
  it("is a first-class provider with aliases, credentials, default, and key redaction", () => {
    for (const alias of ["river", "River-AI", "RIVER.AI"])
      expect(normalizeProvider(alias)).toBe("river");
    expect(getProvider("river")).toBe(riverProvider);
    expect(getEnvVar("river")).toBe("RIVER_API_KEY");
    expect(getDefaultModel("river")).toBe(RIVER_DEFAULT_MODEL);
    expect(riverProvider.validateKey(apiKey)).toBe(true);
    expect(riverProvider.validateKey("bad key")).toBe(false);
    expect(redactSecrets(`Token ${apiKey}`)).toBe("Token rv_••••••");
  });

  it("discovers IDs dynamically and refreshes explicitly requested catalogs", async () => {
    let model = RIVER_DEFAULT_MODEL;
    const { fetchMock } = transport(completion, () => json({ data: [{ id: model }] }));
    expect(await riverProvider.listModels!({ apiKey })).toEqual([model]);
    model = RIVER_GLM_MODEL;
    expect(await riverProvider.listModels!({ apiKey })).toEqual([model]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ authorization: `Bearer ${apiKey}` });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses Chat Completions and parses answer, reasoning, cached input, and usage", async () => {
    const { generations } = transport();
    const result = await riverProvider.complete(REQUEST, { apiKey });
    expect(generations[0]?.url).toBe("https://api.river.ai/v1/chat/completions");
    expect(generations[0]?.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(result).toMatchObject({
      provider: "river", model: RIVER_DEFAULT_MODEL, text: "Answer",
      reasoningBlock: { text: "Consider the evidence" },
      usage: { promptTokens: 120, completionTokens: 30, cachedPromptTokens: 80, reasoningTokens: 10, exact: true },
    });
  });

  it.each([
    [RIVER_DEFAULT_MODEL, "none", false, "none"],
    [RIVER_DEFAULT_MODEL, "high", true, "high"],
    [RIVER_DEFAULT_MODEL, "max", true, "max"],
    ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "none", false, "none"],
    ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "high", true, "high"],
    ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "max", true, "max"],
    [RIVER_DEFAULT_MODEL, "minimal", true, "low"],
    [RIVER_GLM_MODEL, "low", true, "low"],
    [RIVER_GLM_MODEL, "high", true, "high"],
    [RIVER_GLM_MODEL, "max", true, "max"],
    [RIVER_GLM_MODEL, "none", false, "low"],
  ] as const)("serializes %s effort %s (enabled=%s) as %s", async (model, effort: ReasoningEffort, enabled, wire) => {
    const { generations } = transport();
    await riverProvider.complete({ ...REQUEST, model, thinking: { effort, enabled } }, { apiKey });
    expect(JSON.parse(generations[0]!.body)).toMatchObject({ reasoning_effort: wire });
    expect(generations[0]!.body).not.toContain('"thinking"');
  });

  it.each(["complete", "stream"] as const)("uses DeepSeek V4 sampling defaults for %s without changing max effort", async (mode) => {
    const { generations } = transport(mode === "stream" ? () => sse([
      { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] },
    ]) : completion);
    const request = { ...REQUEST, thinking: { enabled: true, effort: "max" as const } };
    if (mode === "stream") await riverProvider.stream!(request, { apiKey }, () => {});
    else await riverProvider.complete(request, { apiKey });
    expect(JSON.parse(generations[0]!.body)).toMatchObject({
      temperature: 1,
      top_p: 0.95,
      reasoning_effort: "max",
    });
  });

  it("preserves an explicit DeepSeek temperature and unrelated River sampling", async () => {
    const { generations } = transport();
    await riverProvider.complete({ ...REQUEST, temperature: 0.7 }, { apiKey });
    expect(JSON.parse(generations[0]!.body)).toMatchObject({ temperature: 0.7, top_p: 0.95 });
    await riverProvider.complete({ ...REQUEST, model: RIVER_GLM_MODEL }, { apiKey });
    expect(JSON.parse(generations[1]!.body)).toMatchObject({ temperature: 0.2 });
    expect(JSON.parse(generations[1]!.body)).not.toHaveProperty("top_p");
  });

  it("sends tools, named selection, image content, and parses tool calls", async () => {
    const { generations } = transport(() => json({
      choices: [{ message: { content: null, reasoning_content: "Read first", tool_calls: [{
        id: "call_file", type: "function", function: { name: "fs_read", arguments: '{"path":"README.md"}' },
      }] }, finish_reason: "tool_calls" }], usage: USAGE,
    }));
    const result = await riverProvider.complete({
      ...REQUEST,
      messages: [...REQUEST.messages, { role: "user", content: "Inspect", images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }] }],
      tools: [TOOL], toolChoice: { type: "function", name: "fs.read" }, parallelToolCalls: false,
    }, { apiKey });
    expect(JSON.parse(generations[0]!.body)).toMatchObject({
      messages: [...REQUEST.messages, { role: "user", content: [
        { type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ] }],
      tools: [{ type: "function", function: { name: "fs_read" } }],
      tool_choice: { type: "function", function: { name: "fs_read" } }, parallel_tool_calls: false,
    });
    expect(result.toolCalls).toEqual([{ id: "call_file", name: "fs.read", args: { path: "README.md" }, rawArguments: '{"path":"README.md"}' }]);
  });

  it("uses live metadata to constrain output and suppress unsupported tools, images and controls", async () => {
    const { generations } = transport(completion, () => json({ data: [{
      id: RIVER_DEFAULT_MODEL, max_output_tokens: 2048, reasoning: false,
      capabilities: { vision: false, function_calling: false },
    }] }));
    await riverProvider.complete({
      ...REQUEST, maxTokens: 100_000, tools: [TOOL], thinking: { enabled: true, effort: "max" },
      messages: [{ role: "user", content: "Inspect", images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }] }],
    }, { apiKey });
    expect(JSON.parse(generations[0]!.body)).toMatchObject({
      max_tokens: 2048,
      messages: [{ role: "user", content: expect.stringContaining("Image input unavailable") }],
    });
    for (const field of ["tools", "tool_choice", "reasoning_effort", "image_url"])
      expect(generations[0]!.body).not.toContain(`"${field}"`);
  });

  it("keeps tool definitions, history and the prompt cache key stable across turns without unsupported cache fields", async () => {
    const { generations } = transport();
    await withSessionAffinity("river-cache", async () => {
      await riverProvider.complete({ ...REQUEST, tools: [TOOL] }, { apiKey });
      await riverProvider.complete({ ...REQUEST, tools: [TOOL], messages: [
        ...REQUEST.messages, { role: "assistant", content: "Answer" }, { role: "user", content: "Next" },
      ] }, { apiKey });
    });
    const first: unknown = JSON.parse(generations[0]!.body);
    expect(JSON.parse(generations[1]!.body)).toMatchObject({
      messages: [...REQUEST.messages, { role: "assistant", content: "Answer" }, { role: "user", content: "Next" }],
    });
    expect(first).toMatchObject({ messages: REQUEST.messages, tools: [{ type: "function", function: { name: "fs_read" } }] });
    const cacheKeys = generations.map(({ body }) => (JSON.parse(body) as { prompt_cache_key?: unknown }).prompt_cache_key);
    expect(typeof cacheKeys[0]).toBe("string");
    expect(new Set(cacheKeys).size).toBe(1);
    for (const { body } of generations)
      for (const field of ["cache_control", "session_id", "store", "previous_response_id"])
        expect(body).not.toContain(`"${field}"`);
  });

  it("isolates cached catalogs by credential and endpoint and reuses the matching route", async () => {
    const { fetchMock, generations } = transport();
    await riverProvider.complete(REQUEST, { apiKey });
    await riverProvider.complete(REQUEST, { apiKey });
    await riverProvider.complete(REQUEST, { apiKey: `${apiKey}_other` });
    await riverProvider.complete(REQUEST, { apiKey, baseUrl: "https://river.example/v1" });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(3);
    expect(generations.at(-1)?.url).toBe("https://river.example/v1/chat/completions");
  });

  it("supports endpoint environment overrides and explicit endpoint precedence", async () => {
    vi.stubEnv("RIVER_BASE_URL", "https://regional.example/");
    const { generations } = transport();
    await riverProvider.complete(REQUEST, { apiKey });
    await riverProvider.complete(REQUEST, { apiKey, baseUrl: "https://explicit.example/v1/models" });
    expect(generations.map(({ url }) => url)).toEqual([
      "https://regional.example/v1/chat/completions", "https://explicit.example/v1/chat/completions",
    ]);
  });

  it("deduplicates concurrent catalog reads", async () => {
    const { fetchMock } = transport();
    await Promise.all([riverProvider.complete(REQUEST, { apiKey }), riverProvider.complete(REQUEST, { apiKey })]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(1);
  });

  it("falls back to documented facts when discovery is unavailable, not when auth is rejected", async () => {
    const { generations } = transport(completion, () => json({ error: "unavailable" }, 503));
    await riverProvider.complete({ ...REQUEST, thinking: { enabled: true, effort: "max" } }, { apiKey });
    expect(JSON.parse(generations[0]!.body)).toMatchObject({ reasoning_effort: "max" });
    const rejected = transport(completion, () => json({ error: "invalid key" }, 401));
    await expect(riverProvider.complete(REQUEST, { apiKey: `${apiKey}_rejected` })).rejects.toMatchObject({ status: 401 });
    expect(rejected.generations).toHaveLength(0);
  });

  it("preserves rate-limit status and retry-after for shared key rotation", async () => {
    transport(() => new Response('{"error":"rate limited"}', { status: 429, headers: { "retry-after": "7" } }));
    await expect(riverProvider.complete(REQUEST, { apiKey })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 });
  });

  it("does not start requests without a key or after cancellation", async () => {
    const { fetchMock } = transport();
    await expect(riverProvider.complete(REQUEST, {})).rejects.toThrow("River API key is required");
    await expect(riverProvider.complete({ ...REQUEST, signal: AbortSignal.abort() }, { apiKey })).rejects.toThrow(/abort/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a prematurely terminated stream instead of claiming a complete answer", async () => {
    transport(() => sse([{ choices: [{ delta: { content: "partial" } }] }], false));
    await expect(riverProvider.stream!(REQUEST, { apiKey }, () => {})).rejects.toThrow(/without terminal proof/);
  });

  it("preserves provider failures as typed errors", async () => {
    transport(() => json({ error: { message: "Unavailable" } }, 503));
    await expect(riverProvider.complete(REQUEST, { apiKey })).rejects.toBeInstanceOf(ProviderError);
  });
});
