import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverClineModelFacts, parseClineModelFacts, resetClineModelMetadataCache } from "../../src/llm/cline-model-catalog.js";
import { displayReasoningEfforts, modelSupportsThinking, registerModelCatalog, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { modelContextWindow, modelMaxOutputTokens } from "../../src/llm/context-windows.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { buildChatBody } from "../../src/llm/wire/chat-body.js";
import { needsEffortPreflight } from "../../src/llm/wire/effort-preflight.js";
import { reasoningOptionValues } from "../../src/ui-core/commands/pickers/search-reasoning.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import type { CatalogFacts } from "../../src/llm/catalog-facts.js";
import { clineProvider } from "../../src/llm/cline.js";
import type { ChatMessage, CompletionRequest, ToolDefinition } from "../../src/types.js";

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

function metadata(openrouter: Record<string, unknown>, pass: Record<string, unknown> = {}) {
  return {
    openrouter: { api: "https://openrouter.ai/api/v1", models: openrouter },
    "cline-pass": { api: "https://api.cline.bot/api/v1", models: pass },
  };
}

function register(facts: readonly CatalogFacts[]): void {
  registerModelCatalog("cline", facts.map((entry) => ({
    id: entry.id, facts: entry, reasoning: entry.reasoning?.supported, vision: entry.vision,
  })));
}

function wire(model: string, enabled = true) {
  const profile = resolveBuiltInProfile({ provider: "cline", model });
  return JSON.parse(buildChatBody({
    providerId: "cline", model, stream: false,
    messages: [{ role: "system", content: "stable instructions" }, { role: "user", content: "hello" }],
    reasoning: { enabled, effort: "xhigh" },
    control: { profile, willReplayReasoning: false },
  }));
}

beforeEach(() => {
  resetClineModelMetadataCache();
  resetReasoningKnowledge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetReasoningKnowledge();
});

describe("dynamic Cline model metadata", () => {
  it("discovers a future model's limits and effort levels without name rules", async () => {
    const published = {
      id: "futurelab/nebula-next", reasoning: true, tool_call: true,
      limit: { context: 524_288, input: 458_752, output: 65_536 },
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning_options: [{ type: "effort", values: ["none", "low", "high", "xhigh"] }],
    };
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => response(metadata({ [published.id]: published })));
    vi.stubGlobal("fetch", fetchMock);
    const facts = await discoverClineModelFacts([{ id: "cline-free/nebula-next", name: "Nebula" }]);
    expect(facts[0]).toMatchObject({
      id: "cline-free/nebula-next", contextTokens: 458_752, nominalContextTokens: 524_288,
      maxOutputTokens: 65_536, vision: true, tools: true,
      reasoning: { supported: true, mandatory: false, supportedEfforts: ["none", "low", "high", "xhigh"] },
    });
    register(facts);
    expect(modelContextWindow("cline-free/nebula-next", "cline")).toBe(458_752);
    expect(modelMaxOutputTokens("cline", "cline-free/nebula-next")).toBe(65_536);
    expect(reasoningOptionValues("cline", "cline-free/nebula-next")).toEqual(["off", "low", "high", "xhigh"]);
    expect(wire("cline-free/nebula-next").reasoning).toEqual({ enabled: true, effort: "xhigh" });
    expect(modelContextWindow("cline-free/nebula-next", "free")).toBe(200_000);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("uses exact Cline Pass limits before matching OpenRouter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(metadata({
      "vendor/nebula": { limit: { context: 1_048_576, output: 262_144 }, reasoning: true },
    }, {
      "cline-pass/nebula": {
        canonical_model_id: "vendor/nebula", limit: { context: 262_144, output: 32_768 },
        reasoning: true, reasoning_options: [{ type: "toggle" }],
      },
    }))));
    const facts = await discoverClineModelFacts([{ id: "cline-pass/nebula" }]);
    expect(facts[0]).toMatchObject({ canonicalModel: "vendor/nebula", contextTokens: 262_144, maxOutputTokens: 32_768 });
    register(facts);
    expect(reasoningOptionValues("cline", "cline-pass/nebula")).toEqual(["off", "on"]);
    expect(wire("cline-pass/nebula").reasoning).toEqual({ enabled: true });
    expect(wire("cline-pass/nebula", false).reasoning).toEqual({ enabled: false });
  });

  it("keeps capabilities directly published by Cline authoritative", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(metadata({
      "vendor/direct": {
        limit: { context: 1_048_576, output: 262_144 }, reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        modalities: { input: ["text", "image"] }, tool_call: true,
      },
    }))));
    const facts = await discoverClineModelFacts([{
      id: "vendor/direct", contextWindow: 393_216, maxInputTokens: 327_680,
      supportsReasoning: false, supportsImages: false, supportsTools: false, tags: ["reasoning"],
    }]);
    expect(facts[0]).toMatchObject({
      contextTokens: 327_680, nominalContextTokens: 393_216, maxOutputTokens: 262_144,
      reasoning: { supported: false, supportedEfforts: [] }, vision: false, tools: false,
    });
    register(facts);
    expect(modelSupportsThinking("cline", "vendor/direct")).toBe(false);
    expect(reasoningOptionValues("cline", "vendor/direct")).toEqual(["off"]);
    expect(wire("vendor/direct")).not.toHaveProperty("reasoning");
  });

  it("does not borrow an ambiguous model slug's capabilities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(metadata({
      "lab-a/same-name": { limit: { context: 65_536, output: 8_192 }, reasoning: false },
      "lab-b/same-name": { limit: { context: 524_288, output: 65_536 }, reasoning: true },
    }))));
    const facts = await discoverClineModelFacts([{ id: "cline-free/same-name" }]);
    expect(facts).toEqual([{ id: "cline-free/same-name" }]);
    const canonical = await discoverClineModelFacts([{ id: "cline-free/same-name", canonical_model_id: "lab-a/same-name" }]);
    expect(canonical[0]?.contextTokens).toBe(65_536);
  });

  it("rejects unrelated provider metadata and inconsistent IDs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      openrouter: { api: "https://unrelated.example", models: { "vendor/model": { limit: { context: 999_999 } } } },
      "cline-pass": { api: "https://api.cline.bot/api/v1", models: { "cline-pass/model": { id: "wrong", limit: { context: 888_888 } } } },
    })));
    const facts = await discoverClineModelFacts([{ id: "vendor/model" }, { id: "cline-pass/model" }]);
    expect(facts.every((entry) => entry.contextTokens === undefined)).toBe(true);
  });

  it("shares concurrent metadata fetches and refreshes a new ID after the cooldown", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetchMock = vi.fn(async () => response(metadata({
      "vendor/old": { limit: { context: 65_536, output: 8_192 }, reasoning: false },
    })));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([discoverClineModelFacts([{ id: "vendor/old" }]), discoverClineModelFacts([{ id: "vendor/old" }])]);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockImplementation(async () => response(metadata({
      "vendor/old": { limit: { context: 65_536, output: 8_192 }, reasoning: false },
      "vendor/new": { limit: { context: 786_432, output: 32_768 }, reasoning: true, reasoning_options: [{ type: "effort", values: ["high"] }] },
    })));
    expect((await discoverClineModelFacts([{ id: "vendor/new" }]))[0]?.contextTokens).toBeUndefined();
    now.mockReturnValue(1_060_001);
    expect((await discoverClineModelFacts([{ id: "vendor/new" }]))[0]?.contextTokens).toBe(786_432);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await discoverClineModelFacts([{ id: "vendor/new" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains known metadata during outages and recovers when lookups resume", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetchMock = vi.fn(async () => response(metadata({
      "vendor/model": { limit: { context: 262_144, output: 32_768 }, reasoning: true, reasoning_options: [{ type: "toggle" }] },
    })));
    vi.stubGlobal("fetch", fetchMock);
    await discoverClineModelFacts([{ id: "vendor/model" }]);
    now.mockReturnValue(1_000_000 + 31 * 60 * 1000);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await discoverClineModelFacts([{ id: "vendor/model" }]))[0]?.contextTokens).toBe(262_144);
    await discoverClineModelFacts([{ id: "vendor/model" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_000_000 + 32 * 60 * 1000);
    fetchMock.mockImplementation(async () => response(metadata({ "vendor/model": { limit: { context: 524_288, output: 65_536 }, reasoning: false } })));
    const updated = await discoverClineModelFacts([{ id: "vendor/model" }]);
    expect(updated[0]?.contextTokens).toBe(524_288);
    expect(updated[0]?.reasoning?.supported).toBe(false);
  });

  it("does not request a supplemental catalog for complete native metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const facts = await discoverClineModelFacts([{
      id: "future/complete", contextWindow: 131_072, maxTokens: 16_384,
      supportsReasoning: true, reasoningOptions: [{ type: "toggle" }],
      supportsImages: true, supportsTools: true,
    }]);
    expect(facts[0]?.reasoning).toMatchObject({ supported: true, mandatory: false, supportedEfforts: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Cline reasoning controls", () => {
  it.each([false, true])("preserves the actual gateway prefix across metadata refreshes (stream %s)", async (stream) => {
    const id = "cline-free/future-cache";
    const facts = parseClineModelFacts({
      id, reasoning: true, reasoning_options: [{ type: "toggle" }],
      limit: { context: 524_288, output: 32_768 }, modalities: { input: ["text", "image"] }, tool_call: true,
    })!;
    register([facts]);
    const bodies: Array<{ messages: unknown[]; tools: unknown[]; session_id?: string; reasoning?: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/chat/completions");
      bodies.push(JSON.parse(String(init?.body)));
      const choice = { index: 0, finish_reason: "stop" };
      return stream
        ? new Response(`data: ${JSON.stringify({ choices: [{ ...choice, delta: { content: "done" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
        : response({ data: { choices: [{ ...choice, message: { content: "done" } }] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tools: ToolDefinition[] = [{ name: "mcp.call", wireName: "mcp_call", description: "Call a discovered tool.", parameters: { type: "object", properties: { name: { type: "string" } } } }];
    const messages: ChatMessage[] = [
      { role: "system", content: "Stable instructions." },
      { role: "user", content: "Read this page.", images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }] },
    ];
    const send = (timeline: ChatMessage[]) => withSessionAffinity("dynamic-cline-cache", () => {
      const request: CompletionRequest = { provider: "cline", model: id, messages: timeline, tools, thinking: { enabled: true, effort: "xhigh" } };
      const auth = { apiKey: "offline-cline-catalog-test" };
      return stream ? clineProvider.stream!(request, auth, () => {}) : clineProvider.complete(request, auth);
    });
    const before = structuredClone(messages);
    await send(messages);
    register([{ ...facts, contextTokens: 786_432 }]);
    await send([
      ...messages,
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "mcp.call", args: { name: "mcp.notion.fetch" } }] },
      { role: "tool", toolCallId: "call-1", content: "Retained notes", ok: true },
      { role: "user", content: "Summarize the notes." },
    ]);
    expect(messages).toEqual(before);
    expect(bodies[1]?.messages.slice(0, bodies[0]?.messages.length)).toEqual(bodies[0]?.messages);
    expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    expect(bodies[1]?.session_id).toBe(bodies[0]?.session_id);
    expect(bodies[0]?.reasoning).toEqual({ enabled: true });
    expect(bodies[1]?.reasoning).toEqual({ enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [[], [], true],
    [[{ type: "toggle" }], ["off", "on"], false],
    [[{ type: "effort", values: ["low", "high"] }], ["low", "high"], true],
    [[{ type: "effort", values: ["none", "high"] }], ["off", "high"], false],
  ])("uses the catalog's controls %j", (options, expected, mandatory) => {
    const facts = parseClineModelFacts({ id: "cline-pass/future", reasoning: true, reasoning_options: options })!;
    register([facts]);
    expect(facts.reasoning?.mandatory).toBe(mandatory);
    expect(reasoningOptionValues("cline", facts.id)).toEqual(expected);
    expect(needsEffortPreflight({ providerId: "cline", model: facts.id, requested: "xhigh", purpose: "turn" })).toBe(false);
    expect(resolveBuiltInProfile({ provider: "cline", model: facts.id }).reasoning.acceptedEfforts).toEqual(facts.reasoning?.supportedEfforts);
  });

  it("replaces old effort and support declarations when the catalog changes", () => {
    const id = "cline-pass/changing";
    register([parseClineModelFacts({ id, reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] })!]);
    expect(displayReasoningEfforts("cline", id)).toEqual(["none", "low", "high"]);
    register([parseClineModelFacts({ id, reasoning: false })!]);
    expect(displayReasoningEfforts("cline", id)).toEqual([]);
    expect(modelSupportsThinking("cline", id)).toBe(false);
    register([parseClineModelFacts({ id, reasoning: true, reasoning_options: [{ type: "toggle" }] })!]);
    expect(reasoningOptionValues("cline", id)).toEqual(["off", "on"]);
    expect(wire(id).reasoning).toEqual({ enabled: true });
  });

  it("keeps toggle controls exact inside an isolated session", () => {
    const facts = parseClineModelFacts({ id: "cline-free/future-toggle", reasoning: true, reasoning_options: [{ type: "toggle" }] })!;
    register([facts]);
    withSessionAffinity("cline-metadata-session:subagent:worker", () => {
      expect(displayReasoningEfforts("cline", facts.id)).toEqual([]);
      expect(wire(facts.id).reasoning).toEqual({ enabled: true });
    });
  });

  it("preserves empty effort controls over a recognized model family's defaults", () => {
    const facts = parseClineModelFacts({ id: "cline-pass/kimi-k3", reasoning: true, reasoning_options: [{ type: "toggle" }] })!;
    register([facts]);
    expect(reasoningOptionValues("cline", facts.id)).toEqual(["off", "on"]);
    expect(wire(facts.id).reasoning).toEqual({ enabled: true });
    expect(wire(facts.id, false).reasoning).toEqual({ enabled: false });
  });
});
