import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, ToolDefinition } from "../../src/types.js";
import {
  clearModelCatalogFacts,
  clearModelVisionCapabilities,
  modelSupportsVision,
  resetReasoningKnowledge,
  resolveToolDialect,
} from "../../src/llm/capabilities.js";
import { modelContextWindow } from "../../src/llm/context-windows.js";
import { listProviderModels } from "../../src/llm/model-discovery.js";
import { invalidateModelLists } from "../../src/llm/model-list-cache.js";
import { getDefaultModel, getEnvVar, normalizeEndpointUrl, normalizeProvider, redactSecrets } from "../../src/llm/provider.js";
import { completeWithProvider, getProvider, streamWithProvider } from "../../src/llm/router.js";
import { sarvamProvider } from "../../src/llm/sarvam.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { getProviderKeys, setProviderKeys } from "../../src/store/keys.js";
import { reasoningOptionValues } from "../../src/ui-core/commands/pickers/search-reasoning.js";

const auth = { apiKey: "sarvam-key-fixture-one" };
const otherAuth = { apiKey: "sarvam-key-fixture-two" };
const image = { mediaType: "image/png", dataBase64: "iVBORw0KGgo=" };
const model = "gemma4";
const request: CompletionRequest = {
  model,
  messages: [{ role: "system", content: "Respond briefly" }, { role: "user", content: "Read this" }],
};
const tool: ToolDefinition = {
  name: "fs.read",
  wireName: "fs_read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const usage = {
  prompt_tokens: 120,
  completion_tokens: 10,
  prompt_tokens_details: { cached_tokens: 30 },
  completion_tokens_details: { reasoning_tokens: 5 },
};
const completion = () => Response.json({
  choices: [{ message: { content: "Answer" }, finish_reason: "stop" }],
  usage,
});

interface Call {
  readonly url: URL;
  readonly headers: Headers;
  readonly body: Record<string, unknown> | undefined;
  readonly redirect: RequestRedirect | undefined;
}

function mockTransport(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const call = {
      url: new URL(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

function stream(frames: readonly string[]): Response {
  return new Response(frames.join("\n\n") + "\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function chatFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}`;
}

function namedFrame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}`;
}

function generationCalls(calls: readonly Call[]): Call[] {
  return calls.filter(({ body }) => body !== undefined);
}

beforeEach(() => {
  vi.stubEnv("SARVAM_BASE_URL", undefined);
  vi.stubEnv("SARVAM_WIRE_API", undefined);
  vi.stubEnv("SARVAM_API_KEY", undefined);
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
  invalidateModelLists("sarvam");
});

afterEach(async () => {
  await setProviderKeys("sarvam", []);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Sarvam Token Factory", () => {
  it("registers provider aliases, the default model, credentials and V2 endpoints", async () => {
    expect(getProvider("sarvam")).toBe(sarvamProvider);
    expect(normalizeProvider("Sarvam Token Factory")).toBe("sarvam");
    expect(getDefaultModel("sarvam")).toBe("glm5.3-flash");
    expect(getEnvVar("sarvam")).toBe("SARVAM_API_KEY");
    expect(normalizeEndpointUrl("https://api.sarvam.ai", "sarvam")).toBe("https://api.sarvam.ai/v2");

    const calls = mockTransport(() => Response.json({ data: [] }));
    await sarvamProvider.ping(auth);
    expect(calls.map(({ url }) => url.href)).toEqual(["https://api.sarvam.ai/v2/models"]);
    expect(calls[0]?.headers.get("api-subscription-key")).toBe(auth.apiKey);
    expect(calls[0]?.headers.has("authorization")).toBe(false);
    expect(calls[0]?.redirect).toBe("error");
    expect(redactSecrets(auth.apiKey)).toBe("[redacted]");
  });

  it("coalesces discovery, uses detail metadata in the picker and updates it on refresh", async () => {
    vi.stubEnv("SARVAM_API_KEY", auth.apiKey);
    let context = 120_000;
    let efforts = ["medium", "high"];
    const calls = mockTransport(({ url, body }) => {
      if (body) return completion();
      if (url.pathname === "/v2/models") {
        return Response.json({ data: [{ id: model }, { id: "embeddinggemma-2" }, { id: "sarvam-prism", type: "decision" }] });
      }
      return Response.json({
        id: model,
        context_length: context,
        max_output_tokens: 1024,
        reasoning: { default_on: false, can_disable: true, efforts },
        supports_image_input: false,
        supports_tools: false,
      });
    });

    const lists = await Promise.all([listProviderModels("sarvam"), listProviderModels("sarvam")]);
    expect(lists).toEqual([[model], [model]]);
    expect(calls.map(({ url }) => url.pathname)).toEqual(["/v2/models", "/v2/models/gemma4"]);
    expect(modelContextWindow(model, "sarvam")).toBe(120_000);
    expect(reasoningOptionValues("sarvam", model)).toEqual(["off", "medium", "high"]);
    expect(modelSupportsVision("sarvam", model)).toBe(false);
    expect(resolveToolDialect("sarvam", model)).toBe("none");

    await sarvamProvider.complete({
      ...request,
      messages: [{ role: "user", content: "Inspect", images: [image] }],
      tools: [tool],
      maxTokens: 8192,
      thinking: { enabled: true, effort: "low" },
    }, auth);
    expect(calls.at(-1)?.body).toMatchObject({
      max_tokens: 1024,
      reasoning_effort: "medium",
      messages: [{ role: "user", content: expect.stringContaining("Image input unavailable") }],
    });
    expect(calls.at(-1)?.body).not.toHaveProperty("tools");

    context = 180_000;
    efforts = ["low"];
    await listProviderModels("sarvam", { refresh: true });
    expect(modelContextWindow(model, "sarvam")).toBe(180_000);
    expect(reasoningOptionValues("sarvam", model)).toEqual(["off", "low"]);
  });

  it("uses complete live list entries and handles models with toggle-only thinking", async () => {
    const toggle = "qwen38-27b";
    const calls = mockTransport(({ body }) => body ? completion() : Response.json({ data: [{
      id: toggle,
      type: "chat",
      access: "provisioned",
      context_length: 262_144,
      supports_image_input: true,
      supports_tools: true,
      tool_choices: ["auto", "none", "required"],
      reasoning: { default_on: true, can_disable: true, efforts: [] },
    }] }));
    expect(await sarvamProvider.listModels!(auth)).toEqual([toggle]);
    expect(calls).toHaveLength(1);
    expect(reasoningOptionValues("sarvam", toggle)).toEqual(["off", "on"]);
    await sarvamProvider.complete({
      ...request,
      model: toggle,
      thinking: { enabled: true, effort: "high" },
      tools: [tool, { ...tool, name: "fs.list", wireName: "fs_list" }],
      toolChoice: { type: "function", name: "fs.read" },
    }, auth);
    await sarvamProvider.complete({
      ...request, model: toggle, thinking: { enabled: false, effort: "high" },
    }, auth);
    expect(generationCalls(calls).map(({ body }) => body?.reasoning_effort)).toEqual([undefined, "none"]);
    expect(generationCalls(calls)[0]?.body).toMatchObject({
      tools: [{ type: "function", function: { name: "fs_read" } }],
      tool_choice: "required",
    });
  });

  it("keeps in-flight model metadata separate by credential and base URL", async () => {
    const calls = mockTransport(({ headers, url, body }) => {
      if (body) return completion();
      const otherKey = headers.get("api-subscription-key") === otherAuth.apiKey;
      const effort = otherKey ? "high" : url.hostname === "proxy.example" ? "max" : "medium";
      return Response.json({ id: model, supported_reasoning_efforts: ["none", effort] });
    });
    const candidate: CompletionRequest = { ...request, thinking: { enabled: true, effort: "low" } };
    await Promise.all([
      sarvamProvider.complete(candidate, auth),
      sarvamProvider.complete(candidate, auth),
      sarvamProvider.complete(candidate, otherAuth),
      sarvamProvider.complete(candidate, { ...auth, baseUrl: "https://proxy.example" }),
    ]);
    expect(calls.filter(({ body }) => !body)).toHaveLength(3);
    expect(generationCalls(calls).map(({ url, headers, body }) => [
      url.hostname, headers.get("api-subscription-key"), body?.reasoning_effort,
    ])).toEqual(expect.arrayContaining([
      ["api.sarvam.ai", auth.apiKey, "medium"],
      ["api.sarvam.ai", otherAuth.apiKey, "high"],
      ["proxy.example", auth.apiKey, "max"],
    ]));
  });

  it("uses documented capabilities when the model endpoint returns only IDs", async () => {
    const calls = mockTransport(({ body, url }) => body ? completion() : Response.json({ id: url.pathname.split("/").at(-1) }));
    expect(modelContextWindow("glm5.3", "sarvam")).toBe(1_048_576);
    expect(modelContextWindow("sarvam-105b-conversations", "sarvam")).toBe(32_000);
    expect(modelSupportsVision("sarvam", "glm5.3")).toBe(false);
    expect(modelSupportsVision("sarvam", "glm5.3-flash")).toBe(true);
    expect(reasoningOptionValues("sarvam", "glm5.3")).toEqual(["low", "high", "max"]);

    await sarvamProvider.complete({ ...request, model: "glm5.3", thinking: { enabled: false, effort: "none" } }, auth);
    await sarvamProvider.complete({ ...request, model: "deepseekv4.1-flash-1017", thinking: { enabled: false, effort: "none" } }, auth);
    await sarvamProvider.complete({ ...request, thinking: { enabled: false, effort: "none" } }, auth);
    expect(generationCalls(calls).map(({ body }) => body?.reasoning_effort)).toEqual(["low", "none", undefined]);
  });

  it("sends inline vision, streams native tool calls and keeps a stable Gemma cache key", async () => {
    const calls = mockTransport(({ body }) => {
      if (!body) return Response.json({ id: model });
      if (!body.stream) return completion();
      return stream([
        chatFrame({ choices: [{ delta: { reasoning_content: "Inspect first" } }] }),
        chatFrame({ choices: [{ delta: {
          tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "fs_read", arguments: '{"path":' } }],
        } }] }),
        chatFrame({ choices: [{ delta: {
          tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }],
        }, finish_reason: "tool_calls" }] }),
        chatFrame({ choices: [], usage }),
        "data: [DONE]",
      ]);
    });
    const deltas = vi.fn();
    const initial: CompletionRequest = {
      ...request,
      messages: [...request.messages.slice(0, 1), { ...request.messages[1]!, images: [image] }],
      tools: [tool],
      toolChoice: { type: "function", name: "fs.read" },
      parallelToolCalls: false,
      thinking: { enabled: true, effort: "high" },
    };

    await withSessionAffinity("session-one", async () => {
      const result = await sarvamProvider.stream!({ ...initial, onToolCallDelta: deltas }, auth, vi.fn());
      expect(result).toMatchObject({
        finishReason: "tool_calls",
        toolCalls: [{ id: "call_read", name: "fs.read", args: { path: "README.md" } }],
        reasoningBlock: { text: "Inspect first" },
        usage: { promptTokens: 120, cachedPromptTokens: 30, reasoningTokens: 5 },
      });
      expect(deltas).toHaveBeenCalled();
      await sarvamProvider.complete({
        ...initial,
        messages: [...initial.messages, {
          role: "assistant", content: "", toolCalls: result.toolCalls, reasoningArtifacts: result.reasoningArtifacts,
        }, {
          role: "tool", toolCallId: "call_read", content: "File contents",
        }],
      }, auth);
      await sarvamProvider.complete({ ...initial, purpose: "auxiliary" }, auth);
    });
    await withSessionAffinity("session-two", () => sarvamProvider.complete(initial, auth));
    const [first, next, auxiliary, other] = generationCalls(calls);
    const affinity = first?.headers.get("x-session-affinity");
    expect(affinity).toMatch(/^clai-[a-f0-9]{40}$/);
    expect(next?.headers.get("x-session-affinity")).toBe(affinity);
    expect(auxiliary?.headers.has("x-session-affinity")).toBe(false);
    expect(other?.headers.get("x-session-affinity")).not.toBe(affinity);
    expect(first?.headers.has("x-clai-session")).toBe(false);
    expect(first?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
      parallel_tool_calls: false,
      tool_choice: { type: "function", function: { name: "fs_read" } },
      messages: [{ role: "system", content: "Respond briefly" }, {
        role: "user", content: [
          { type: "text", text: "Read this" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${image.dataBase64}` } },
        ],
      }],
    });
    expect(first?.body).not.toHaveProperty("prompt_cache_key");
    expect(next?.body?.tools).toEqual(first?.body?.tools);
    expect(next?.body?.messages).toEqual(expect.arrayContaining([
      { role: "tool", tool_call_id: "call_read", content: "File contents" },
    ]));
  });

  it("uses stateless Responses with route-specific effort, images, flat tools and named SSE", async () => {
    vi.stubEnv("SARVAM_WIRE_API", "responses");
    const reasoning = { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "Check the image" }] };
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "fs_read", arguments: '{"path":"README.md"}' };
    const outputUsage = {
      input_tokens: 120, output_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 5 },
    };
    const calls = mockTransport(({ url, body }) => {
      if (!body) return Response.json({ id: url.pathname.split("/").at(-1) });
      if (!body.stream) return Response.json({ status: "completed", output: [reasoning, call], usage: outputUsage });
      return stream([
        namedFrame("response.reasoning_text.delta", { delta: "Check the image" }),
        namedFrame("response.output_item.added", { item: call, output_index: 1 }),
        namedFrame("response.function_call_arguments.done", { item_id: call.id, arguments: call.arguments }),
        namedFrame("response.completed", { response: { status: "completed", output: [reasoning, call], usage: outputUsage } }),
      ]);
    });
    const selected: CompletionRequest = {
      ...request,
      model: "glm5.3-flash",
      messages: [{ role: "user", content: "Read this", images: [image] }],
      tools: [tool],
      toolChoice: { type: "function", name: "fs.read" },
      parallelToolCalls: false,
      thinking: { enabled: true, effort: "max" },
    };
    expect(reasoningOptionValues("sarvam", selected.model!)).toEqual(["low", "high"]);
    const result = await withSessionAffinity("responses-session", () => sarvamProvider.complete(selected, auth));
    const events = vi.fn();
    const streamed = await sarvamProvider.stream!({
      ...selected,
      messages: [...selected.messages, {
        role: "assistant", content: "", toolCalls: result.toolCalls,
      }, { role: "tool", content: "File contents", toolCallId: "call_1" }],
      onStreamEvent: events,
    }, auth, vi.fn());

    expect(result).toMatchObject({ api: "responses", reasoningBlock: { text: "Check the image" } });
    expect(streamed.toolCalls).toEqual(result.toolCalls);
    expect(streamed.usage).toMatchObject({ cachedPromptTokens: 0, reasoningTokens: 5 });
    expect(events).toHaveBeenCalledWith({ type: "reasoning_delta", text: "Check the image" });
    const [first, next] = generationCalls(calls);
    expect(first?.url.pathname).toBe("/v2/responses");
    expect(first?.redirect).toBe("error");
    expect(next?.redirect).toBe("error");
    expect(first?.headers.has("x-session-affinity")).toBe(false);
    expect(first?.body).toMatchObject({
      store: false,
      reasoning: { effort: "high" },
      max_output_tokens: expect.any(Number),
      tools: [{ type: "function", name: "fs_read" }],
      tool_choice: { type: "function", name: "fs_read" },
      parallel_tool_calls: false,
      input: [{ role: "user", content: [
        { type: "input_text", text: "Read this" },
        { type: "input_image", image_url: `data:image/png;base64,${image.dataBase64}` },
      ] }],
    });
    expect(next?.body?.input).toEqual(expect.arrayContaining([
      { type: "function_call", call_id: "call_1", name: "fs_read", arguments: call.arguments },
      { type: "function_call_output", call_id: "call_1", output: "File contents" },
    ]));
    expect(next?.body).not.toHaveProperty("previous_response_id");
    expect(next?.body).not.toHaveProperty("stream_options");
    await sarvamProvider.complete({ ...request, model: "glm5.3", thinking: selected.thinking }, auth);
    expect(calls.at(-1)?.body).not.toHaveProperty("reasoning");
  });

  it.each([
    [403, "invalid_api_key_error", "Invalid API key"],
    [402, "insufficient_quota_error", "Quota exhausted"],
    [429, "rate_limit_exceeded_error", "Rate limited"],
    [404, "not_found_error", "Model 'gemma4' not found."],
    [400, "invalid_request_error", "Model is not enabled for your organisation"],
  ] as const)("rotates keys after HTTP %i using the second key's metadata", async (status, code, message) => {
    await setProviderKeys("sarvam", [auth.apiKey, otherAuth.apiKey]);
    const calls = mockTransport(({ headers, body }) => {
      const firstKey = headers.get("api-subscription-key") === auth.apiKey;
      if (!body) return Response.json({
        id: model, supported_reasoning_efforts: ["none", firstKey ? "high" : "low"],
      });
      return firstKey ? Response.json({ error: { code, message } }, { status }) : completion();
    });
    const result = await completeWithProvider({
      ...request,
      provider: "sarvam",
      thinking: { enabled: true, effort: "max" },
    }, { retryRateLimits: false, allowProviderFallback: false });
    expect(result.text).toBe("Answer");
    expect(generationCalls(calls).map(({ headers, body }) => [
      headers.get("api-subscription-key"), body?.reasoning_effort,
    ])).toEqual([[auth.apiKey, "high"], [otherAuth.apiKey, "low"]]);
    await vi.waitFor(async () => expect((await getProviderKeys("sarvam")).activeIndex).toBe(1));
  });

  it("does not start a second stream after the first key has emitted output", async () => {
    await setProviderKeys("sarvam", [auth.apiKey, otherAuth.apiKey]);
    const calls = mockTransport(({ body }) => body ? stream([
      chatFrame({ choices: [{ delta: { content: "Partial" } }] }),
      chatFrame({ error: { code: "invalid_api_key_error", message: "Invalid API key" } }),
    ]) : Response.json({ id: model }));
    const output = vi.fn();
    await expect(streamWithProvider({ ...request, provider: "sarvam" }, output, {
      onStatus: vi.fn(), allowProviderFallback: false,
    })).rejects.toThrow(/invalid api key/i);
    expect(output.mock.calls).toEqual([["Partial"]]);
    expect(generationCalls(calls)).toHaveLength(1);
  });

  it("does not post after metadata rejects the key or a caller aborts", async () => {
    const calls = mockTransport(() => Response.json({ error: { message: "Invalid API key" } }, { status: 403 }));
    await expect(sarvamProvider.complete(request, auth)).rejects.toMatchObject({ status: 403 });
    await expect(sarvamProvider.complete({ ...request, signal: AbortSignal.abort() }, auth)).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(1);
    expect(generationCalls(calls)).toEqual([]);
  });
});
