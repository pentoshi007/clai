import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest, ToolDefinition } from "../src/types.js";
import { codexProvider, resetCodexModelCache } from "../src/llm/codex.js";
import { CODEX_CLIENT_VERSION, codexWindowId, encodeCodexKey } from "../src/llm/codex-auth.js";
import { modelCatalogFacts, resetReasoningKnowledge } from "../src/llm/capabilities.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import { appendAssistantWithTools } from "../src/agent/tool-history.js";
import { createTurnHistoryWriter } from "../src/agent/turn/history-writer.js";
import { responsesReplayItems } from "../src/llm/responses-replay.js";
import { codexBalanceFromUsage, fetchCodexUsage } from "../src/llm/codex-usage.js";
import { formatProviderBalanceSection, handleUsage } from "../src/ui-core/commands/session-commands.js";
import { resetProviderBalancesForTesting, getProviderBalanceSnapshot } from "../src/llm/provider-balance.js";
import type { ArtifactPagerSource } from "../src/ui-core/rendering/artifact-pager-source.js";
import { withCodexCredential } from "../src/llm/codex-credential.js";
import { buildResponsesBody } from "../src/llm/responses-request.js";
import { codexConfigFor } from "../src/llm/codex-config.js";
import { withRequestPurpose } from "../src/llm/request-purpose.js";
import { ProviderError } from "../src/llm/http.js";

const model = "gpt-test-dynamic";
const auth = { apiKey: encodeCodexKey({ accessToken: "access-token", accountId: "test-account" }) };
const catalog = { models: [{
  slug: model,
  visibility: "list",
  context_window: 272_000,
  max_context_window: 872_000,
  effective_context_window_percent: 95,
  supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "max" }, { effort: "ultra" }],
  default_reasoning_level: "low",
  multi_agent_reasoning_effort: "max",
  default_reasoning_summary: "none",
  support_verbosity: true,
  default_verbosity: "low",
  input_modalities: ["text", "image"],
}] };
const json = (value: unknown, headers?: HeadersInit): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
const answer = [{ type: "message", id: "msg_original", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] }];
const tool: ToolDefinition = {
  name: "shell", wireName: "shell", description: "Run a command",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

beforeEach(() => {
  resetCodexModelCache();
  resetReasoningKnowledge();
  resetProviderBalancesForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProviderBalancesForTesting();
});

describe("ChatGPT model discovery", () => {
  it("discovers new model families, filters picker visibility, and retains catalog limits and efforts", async () => {
    const fetch = vi.fn(async () => json({ models: [...catalog.models, { slug: "hidden-model", visibility: "hide", context_window: 100_000 }] }));
    vi.stubGlobal("fetch", fetch);
    expect(await codexProvider.listModels!(auth)).toEqual([model]);
    expect(modelCatalogFacts("codex", model)).toMatchObject({
      contextTokens: 258_400, nominalContextTokens: 272_000,
      vision: true, reasoning: { supported: true, defaultEffort: "low", supportedEfforts: ["low", "medium", "max"] },
    });
    expect(modelCatalogFacts("codex", "hidden-model")?.contextTokens).toBe(95_000);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`client_version=${CODEX_CLIENT_VERSION}`);
  });

  it("deduplicates simultaneous discovery and keeps account catalogs separate", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const account = new Headers(init?.headers).get("chatgpt-account-id");
      return json({ models: [{ slug: `model-${account}` }] });
    });
    vi.stubGlobal("fetch", fetch);
    const first = codexProvider.listModels!(auth);
    const second = codexProvider.listModels!(auth);
    expect(await Promise.all([first, second])).toEqual([["model-test-account"], ["model-test-account"]]);
    const other = { apiKey: encodeCodexKey({ accessToken: "another-token", accountId: "another-account" }) };
    expect(await codexProvider.listModels!(other)).toEqual(["model-another-account"]);
    expect(await codexProvider.listModels!(auth)).toEqual(["model-test-account"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("revalidates expired catalogs by ETag and preserves metadata on a 304", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => json(catalog, { etag: '"catalog-v1"' }));
    vi.stubGlobal("fetch", fetch);
    await codexProvider.listModels!(auth);
    clock.mockReturnValue(now + 301_000);
    fetch.mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"catalog-v1"');
      return new Response(null, { status: 304 });
    });
    expect(await codexProvider.listModels!(auth)).toEqual([model]);
    expect(modelCatalogFacts("codex", model)?.contextTokens).toBe(258_400);
    await codexProvider.listModels!(auth);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache malformed successful responses as the account catalog", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(catalog));
    vi.stubGlobal("fetch", fetch);
    await expect(codexProvider.listModels!(auth)).rejects.toThrow("empty model catalog");
    expect(await codexProvider.listModels!(auth)).toEqual([model]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never offers the removed ultra effort for Codex models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(catalog)));
    await codexProvider.listModels!(auth);
    const { reasoningOptionValues } = await import("../src/ui-core/commands/pickers/search-reasoning.js");
    const options = reasoningOptionValues("codex", model);
    expect(options).toContain("max");
    expect(options).not.toContain("ultra");
  });
});

describe("Codex request parity", () => {
  it("sends supported xhigh effort and opts into streamed summaries when thinking is enabled", async () => {
    const bodies: Record<string, unknown>[] = [];
    const dynamicModel = {
      slug: "gpt-6.1-sol",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      default_reasoning_level: "low",
      default_reasoning_summary: "none",
      supports_reasoning_summary_parameter: true,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/models?")) return json({ models: [dynamicModel] });
      bodies.push(JSON.parse(String(init?.body)));
      return json({ output: answer });
    }));

    await codexProvider.complete({
      model: dynamicModel.slug,
      messages: [{ role: "user", content: "Think carefully and answer." }],
      thinking: { enabled: true, effort: "xhigh" },
    }, auth);

    expect(bodies[0]?.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });

  it("requests summaries while preserving catalog-supported efforts", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/models?")) return json(catalog);
      bodies.push(JSON.parse(String(init?.body)));
      return json({ output: answer });
    }));
    const supported = ["low", "medium", "max"] as const;
    for (const effort of supported) {
      await codexProvider.complete({
        model,
        messages: [{ role: "user", content: "Answer" }],
        thinking: { enabled: true, effort },
      }, auth);
    }
    await codexProvider.complete({
      model,
      messages: [{ role: "user", content: "Answer" }],
      thinking: { enabled: true, effort: "high" },
    }, auth);
    const sent = bodies.map((body) => (body.reasoning as { effort?: string } | undefined)?.effort);
    expect(sent).toEqual(["low", "medium", "max", "medium"]);
    for (const body of bodies) {
      expect(body.reasoning).toHaveProperty("summary", "auto");
      expect(body.reasoning).not.toHaveProperty("context");
    }
  });

  it.each([
    { defaultSummary: "none", supportsSummary: true, enabled: true, expected: "auto" },
    { defaultSummary: undefined, supportsSummary: undefined, enabled: true, expected: "auto" },
    { defaultSummary: "concise", supportsSummary: true, enabled: true, expected: "concise" },
    { defaultSummary: "auto", supportsSummary: false, enabled: true, expected: undefined },
    { defaultSummary: "auto", supportsSummary: true, enabled: false, expected: undefined },
    { defaultSummary: "auto", supportsSummary: true, enabled: undefined, expected: undefined },
  ])("gates summaries using catalog capabilities and thinking: $defaultSummary/$supportsSummary/$enabled", async ({ defaultSummary, supportsSummary, enabled, expected }) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/models?")) return json({ models: [{
        ...catalog.models[0], default_reasoning_summary: defaultSummary, supports_reasoning_summary_parameter: supportsSummary,
      }] });
      bodies.push(JSON.parse(String(init?.body)));
      return json({ output: answer });
    }));
    await codexProvider.complete({
      model, messages: [{ role: "user", content: "Answer" }],
      ...(enabled !== undefined ? { thinking: { enabled, effort: "max" as const } } : {}),
    }, auth);
    if (expected) expect(bodies[0]?.reasoning).toHaveProperty("summary", expected);
    else expect(bodies[0]?.reasoning).not.toHaveProperty("summary");
  });

  it.each(["streamed", "final", "private"] as const)("handles %s reasoning with summaries requested", async (mode) => {
    const summaryText = "I checked the supplied evidence.";
    const reasoning = {
      id: "rs_summary", type: "reasoning", encrypted_content: "PRIVATE_ENCRYPTED_REASONING",
      summary: mode === "private" ? [] : [{ type: "summary_text", text: summaryText }],
    };
    const frames = [
      { type: "response.created", response: { id: "resp_summary" } },
      ...(mode === "streamed" ? [
        { type: "response.reasoning_summary_text.delta", item_id: reasoning.id, delta: "I checked " },
        { type: "response.reasoning_summary_text.delta", item_id: reasoning.id, delta: "the supplied evidence." },
        { type: "response.reasoning_summary_text.done", item_id: reasoning.id, text: summaryText },
      ] : []),
      { type: "response.output_text.delta", item_id: "msg_original", delta: "Done." },
      { type: "response.completed", response: {
        id: "resp_summary", status: "completed", output: [reasoning, ...answer],
        usage: { input_tokens: 12, output_tokens: 9, output_tokens_details: { reasoning_tokens: 8 } },
      } },
    ];
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/models?")) return json(catalog);
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const deltas: string[] = [];
    const tokens: string[] = [];
    const result = await codexProvider.stream!({
      model, messages: [{ role: "user", content: "Check and answer." }], thinking: { enabled: true, effort: "max" },
      onStreamEvent(event) { if (event.type === "reasoning_delta") deltas.push(event.text); },
    }, auth, (token) => tokens.push(token));
    expect(bodies[0]?.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(tokens.join("")).toBe("Done.");
    expect(result.text).toBe("Done.");
    expect(deltas.join("")).not.toContain("PRIVATE_ENCRYPTED_REASONING");
    expect(result.reasoningBlock?.text).not.toContain("PRIVATE_ENCRYPTED_REASONING");
    if (mode === "private") {
      expect(deltas.join("")).toMatch(/Reasoning is private/);
      expect(result.reasoningBlock?.text).toMatch(/Reasoning is private/);
    } else {
      expect(deltas.join("")).toBe(summaryText);
      expect(result.reasoningBlock?.text).toBe(summaryText);
      expect(result.reasoningBlock?.text).not.toMatch(/Reasoning is private/);
    }
  });

  it("builds a valid Codex body for a manual compaction and keeps the cached prefix stable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(catalog)));
    await codexProvider.listModels!(auth);
    const config = codexConfigFor({ accessToken: "token", accountId: "account" });
    const messages: ChatMessage[] = [
      { role: "system", content: "Stable instructions" },
      { role: "user", content: "First turn" },
    ];
    const params = { model, messages, stream: true, tools: [tool], reasoning: { enabled: true, effort: "max" as const } };
    const first = JSON.parse(withSessionAffinity("session-compact", () => buildResponsesBody(config, params))) as Record<string, unknown>;
    const compaction = JSON.parse(withSessionAffinity("session-compact", () => buildResponsesBody(config, { ...params, purpose: "compaction" }))) as Record<string, unknown>;

    expect(compaction).not.toHaveProperty("temperature");
    expect(compaction).not.toHaveProperty("max_output_tokens");
    expect(compaction.instructions).toBe(first.instructions);
    expect(compaction.tools).toEqual(first.tools);
    expect(compaction.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(compaction.prompt_cache_key).toBe("session-compact");
    expect((compaction.client_metadata as Record<string, string>).session_id).toBe((first.client_metadata as Record<string, string>).session_id);
    expect(compaction.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(compaction.reasoning).not.toHaveProperty("context");
  });

  it("uses Codex Responses Lite prefixes, namespaces and stable UUID identities", async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/models?")) {
        return json({ models: [{ ...catalog.models[0], use_responses_lite: true }] });
      }
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(new Headers(init?.headers));
      return json({ output: answer });
    }));
    const request: CompletionRequest = {
      model,
      messages: [{ role: "system", content: "Stable instructions" }, { role: "user", content: "First turn" }],
      tools: [tool],
      thinking: { enabled: true, effort: "max" },
    };
    await withSessionAffinity("session-lite", () => codexProvider.complete(request, auth));
    expect(bodies[0]).toMatchObject({
      model, stream: true, tool_choice: "auto", parallel_tool_calls: false,
      reasoning: { effort: "max", summary: "auto", context: "all_turns" },
    });
    expect(bodies[0]).not.toHaveProperty("instructions");
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(headers[0]?.get("x-openai-internal-codex-responses-lite")).toBe("true");
    const input = bodies[0]!.input as Record<string, unknown>[];
    expect(input.slice(0, 2)).toEqual([
      {
        type: "additional_tools", id: "at_f54cda01-5504-556c-9b22-d72bc1ed3b97", role: "developer",
        tools: [{ type: "namespace", name: "functions", description: "", tools: [{
          type: "function", name: "shell", description: "Run a command", parameters: tool.parameters, strict: false,
        }] }],
      },
      {
        type: "message", id: "msg_ab7dd159-34c6-5d8c-8127-2cc250499615", role: "developer",
        content: [{ type: "input_text", text: "Stable instructions" }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["model.base_instructions"] },
      },
    ]);
    await withSessionAffinity("session-lite", () => codexProvider.complete({ ...request, messages: [...request.messages, { role: "user", content: "Next turn" }] }, auth));
    expect((bodies[1]!.input as unknown[]).slice(0, input.length)).toEqual(input);
  });

  it("sends the complete Codex payload with catalog defaults and explicit tool settings", async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/models?")) return json(catalog);
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(new Headers(init?.headers));
      return json({ output: answer, usage: { input_tokens: 2000, output_tokens: 2, input_tokens_details: { cached_tokens: 1536 } } });
    }));
    const request: CompletionRequest = {
      model, messages: [{ role: "system", content: "Stable instructions" }, { role: "user", content: "First turn" }, { role: "system", content: "REQUEST CONTEXT\nFirst context" }],
      tools: [tool], temperature: 0.2, maxTokens: 128, parallelToolCalls: false,
    };
    const result = await withSessionAffinity("session-1", () => codexProvider.complete(request, auth));
    expect(bodies[0]).toEqual({
      model,
      instructions: "Stable instructions",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "First turn" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "REQUEST CONTEXT\nFirst context" }] },
      ],
      tools: [{ type: "function", name: "shell", description: "Run a command", parameters: tool.parameters, strict: false }],
      tool_choice: "auto", parallel_tool_calls: false,
      reasoning: { effort: "low" }, text: { verbosity: "low" }, store: false, stream: true,
      include: ["reasoning.encrypted_content"], prompt_cache_key: "session-1",
      client_metadata: expect.objectContaining({ session_id: "session-1", thread_id: "session-1" }),
    });
    expect(headers[0]?.get("session-id")).toBe("session-1");
    expect(headers[0]?.get("thread-id")).toBe("session-1");
    expect(headers[0]?.get("originator")).toBe("codex_cli_rs");
    expect(headers[0]?.get("x-codex-window-id")).toBe(codexWindowId("session-1"));
    const metadata = (bodies[0]?.client_metadata ?? {}) as Record<string, string>;
    expect(metadata.installation_id).toMatch(/^[0-9a-fA-F-]{36}$/);
    expect(metadata.window_id).toBe(codexWindowId("session-1"));
    expect(headers[0]?.get("x-openai-internal-codex-responses-lite")).toBeNull();
    expect(result.usage?.cachedPromptTokens).toBe(1536);
    const messages: ChatMessage[] = [...request.messages];
    createTurnHistoryWriter({ messages, images: undefined, sanitizeAssistantText: (text) => text, visibleCommitted: () => true, writeAssistantMessage: () => {} }).pushAssistantHistory(result.text, result);
    messages.push({ role: "user", content: "Next turn" }, { role: "system", content: "REQUEST CONTEXT\nChanged context" });
    await withSessionAffinity("session-1", () => codexProvider.complete({ ...request, messages, thinking: { enabled: true, effort: "max" } }, auth));
    expect(bodies[1]?.instructions).toBe(bodies[0]?.instructions);
    expect((bodies[1]?.input as unknown[]).slice(0, 3)).toEqual([...(bodies[0]?.input as unknown[]), ...answer]);
    expect(bodies[1]?.reasoning).toEqual({ effort: "max", summary: "auto" });
  });

  it("replays original reasoning and tool items in order and invalidates replay when history changes", async () => {
    const output = [
      { type: "reasoning", id: "rs_original", summary: [], encrypted_content: "encrypted-original" },
      { type: "message", id: "msg_commentary", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking." }] },
      { type: "function_call", id: "fc_original", call_id: "call_1", name: "shell", arguments: '{ "command": "pwd" }' },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url).includes("/models?") ? json(catalog) : json({ output })));
    const result = await codexProvider.complete({ model, messages: [{ role: "user", content: "Check" }], tools: [tool] }, auth);
    const history: ChatMessage[] = [];
    appendAssistantWithTools(history, result.text, result.toolCalls!, result.reasoningBlock, result.reasoningArtifacts, result.responsesReplay);
    const restored = JSON.parse(JSON.stringify(history[0])) as ChatMessage;
    expect(responsesReplayItems(restored, "codex", model)).toEqual(output);
    expect(responsesReplayItems({ ...restored, content: "Compacted" }, "codex", model)).toBeUndefined();
    expect(responsesReplayItems(restored, "openai", model)).toBeUndefined();
    expect(responsesReplayItems(restored, "codex", "different-model")).toBeUndefined();
    expect(responsesReplayItems({ ...restored, toolCalls: [{ ...restored.toolCalls![0]!, args: { command: "ls" } }] }, "codex", model)).toBeUndefined();
  });

  it("preserves final encrypted reasoning and captures item-done streams without a final output array", async () => {
    const output = [{ type: "reasoning", id: "rs_final", summary: [], encrypted_content: "final-encrypted" }, ...answer];
    const stream = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Done." })}\n\n`
      + output.map((item, output_index) => `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`).join("")
      + `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 2 } } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url).includes("/models?") ? json(catalog) : new Response(stream, { headers: { "content-type": "text/event-stream" } })));
    const result = await codexProvider.stream!({ model, messages: [{ role: "user", content: "Answer" }] }, auth, () => {});
    expect(result.reasoningArtifacts?.[0]?.replay).toEqual({ scope: "all-history", persistence: "all-turns" });
    const history: ChatMessage[] = [];
    createTurnHistoryWriter({ messages: history, images: undefined, sanitizeAssistantText: (text) => text, visibleCommitted: () => true, writeAssistantMessage: () => {} }).pushAssistantHistory(result.text, result);
    expect(history[0]?.reasoningArtifacts?.[0]?.raw).toEqual(output[0]);
    expect(history[0]?.responsesReplay?.items).toEqual(output);
  });
});

describe("ChatGPT subscription usage", () => {
  it("renders all rate windows, additional quotas, reset times and credits", () => {
    const balance = codexBalanceFromUsage({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1790884734 }, secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1791471534 } },
      additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000 } } }],
      credits: { has_credits: true, unlimited: false, balance: "12.50" },
    });
    const body = formatProviderBalanceSection("ChatGPT subscription", { state: "ready", balance });
    expect(balance.breakdowns.map(({ used, limit }) => ({ used, limit }))).toEqual([{ used: 25, limit: 100 }, { used: 5, limit: 100 }, { used: 40, limit: 100 }]);
    expect(body).toContain("75% remaining");
    expect(body).toContain("95% remaining");
    expect(body).toContain("spark · 5 hour limit");
    expect(body).toContain("12.5 remaining");
    expect(body).toContain("2026-10-01");
    expect(formatProviderBalanceSection("ChatGPT subscription", { state: "ready", balance: codexBalanceFromUsage({ credits: { unlimited: true } }) })).toContain("unlimited");
    expect(() => codexBalanceFromUsage({})).toThrow("no subscription details");
  });

  it("labels reset countdown hours and minutes and clamps expired windows", () => {
    const now = Date.UTC(2026, 9, 3, 6);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const balance = codexBalanceFromUsage({
      rate_limit: {
        primary_window: { used_percent: 25, reset_after_seconds: 3661 },
        secondary_window: { used_percent: 5, reset_after_seconds: 90000 },
      },
    });
    const render = () => formatProviderBalanceSection("ChatGPT subscription", { state: "ready", balance });
    expect(render()).toContain("(in 01h:02m)");
    expect(render()).toContain("(in 25h:00m)");
    clock.mockReturnValue(now + 61_000);
    expect(render()).toContain("(in 01h:00m)");
    clock.mockReturnValue(now + 121_000);
    expect(render()).toContain("(in 00h:59m)");
    clock.mockReturnValue(now + 3661_000);
    expect(render()).toContain("(in 00h:00m)");
    expect(render()).toContain("(in 23h:59m)");
  });

  it("fetches subscription usage with account authentication and residency", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer usage-access");
      expect(headers.get("chatgpt-account-id")).toBe("usage-account");
      expect(headers.get("x-openai-internal-codex-residency")).toBe("eu");
      return json({ plan_type: "pro", credits: { unlimited: true } });
    });
    vi.stubGlobal("fetch", fetch);
    const balance = await fetchCodexUsage({ apiKey: encodeCodexKey({ accessToken: "usage-access", accountId: "usage-account", residency: "eu" }) });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(balance).toMatchObject({ provider: "codex", plan: "pro", accountId: "usage-account" });
  });

  it("updates the shared usage pager even when the session has no token usage", async () => {
    vi.spyOn(await import("../src/store/keys.js"), "getProviderSecret").mockResolvedValue({ value: auth.apiKey, source: "fallback" });
    vi.stubGlobal("fetch", vi.fn(async () => json({ plan_type: "plus", credits: { has_credits: true, balance: "7" } })));
    let pager: ArtifactPagerSource | undefined;
    let initial = "";
    const services = {
      session: {
        getState: () => ({ sessionId: "usage-session", provider: "codex" }),
        usageReport: () => ({ routes: [], totals: { routes: 0, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, apis: [], charges: [] } }),
        subscribe: () => () => {}, notice: () => {},
      },
      overlay: { openPager: (_title: string, body: string, source: ArtifactPagerSource) => { initial = body; pager = source; return true; } },
    };
    handleUsage(services as never);
    expect(initial).toContain("fetching live balance");
    await vi.waitFor(() => expect(getProviderBalanceSnapshot("codex").state).toBe("ready"));
    expect(await pager!.readAll()).toContain("credits: **7 remaining**");
    pager!.dispose();
  });
});

describe("shared ChatGPT credential refresh", () => {
  it("refreshes once when model discovery and usage start with the same expired token", async () => {
    const expired = encodeCodexKey({
      accessToken: "expired", refreshToken: "refresh", accountId: "account", expiresAt: Date.now() - 1000,
    });
    const renewed = encodeCodexKey({
      accessToken: "renewed", refreshToken: "next-refresh", accountId: "account", expiresAt: Date.now() + 3600_000,
    });
    const refresh = vi.spyOn(await import("../src/llm/codex-auth.js"), "maybeRefreshCodexCredential").mockResolvedValue(renewed);
    vi.spyOn(await import("../src/store/keys.js"), "getProviderKeys").mockResolvedValue({ source: "env", keys: [], activeIndex: 0 } as never);
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer renewed");
      return String(url).includes("/models?") ? json(catalog) : json({ plan_type: "plus" });
    }));
    await Promise.all([codexProvider.listModels!({ apiKey: expired }), fetchCodexUsage({ apiKey: expired })]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retries a rejected user turn with the current refresh token", async () => {
    const renewed = encodeCodexKey({ accessToken: "renewed", accountId: "test-account" });
    const refresh = vi.spyOn(await import("../src/llm/codex-auth.js"), "maybeRefreshCodexCredential").mockResolvedValue(renewed);
    vi.spyOn(await import("../src/store/keys.js"), "getProviderKeys").mockResolvedValue({ source: "env", keys: [], activeIndex: 0 } as never);
    const run = vi.fn(async (credential: { accessToken: string }) => {
      if (credential.accessToken !== "renewed") throw new ProviderError("Expired", 401);
      return credential.accessToken;
    });
    expect(await withRequestPurpose("turn", () => withCodexCredential(auth, run))).toBe("renewed");
    expect(run).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith(auth.apiKey);
  });
});
