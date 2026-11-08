import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearModelCatalogFacts,
  clearModelVisionCapabilities,
  clearProviderModelKnowledge,
  displayReasoningEfforts,
  modelCatalogFacts,
  modelVisionSupport,
  resetReasoningKnowledge,
  routeReasoningIsMandatory,
} from "../../src/llm/capabilities.js";
import { modelContextWindow } from "../../src/llm/context-windows.js";
import { getDefaultModel, normalizeProvider } from "../../src/llm/provider.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import {
  refuselessProvider,
  resetRefuselessModelCache,
} from "../../src/llm/refuseless.js";
import { respanProvider, resetRespanModelCache } from "../../src/llm/respan.js";
import {
  resetSilkComputeModelCache,
  silkcomputeProvider,
} from "../../src/llm/silkcompute.js";
import { providers } from "../../src/llm/routing/provider-selection.js";
import {
  resetUnalignedModelCache,
  unalignedProvider,
} from "../../src/llm/unaligned.js";
import {
  resetUnrestrictedModelCache,
  unrestrictedProvider,
} from "../../src/llm/unrestricted.js";
import { getKnownModels } from "../../src/app/commands/catalog.js";
import {
  providerUsesEndpoints,
  resolveProviderCategory,
} from "../../src/store/config.js";
import type { ChatMessage, CompletionRequest, ProviderId } from "../../src/types.js";

const KEYS = {
  refuseless: "abl_0123456789abcdef0123",
  unrestricted: "unr_sk_0123456789abcdef",
  unaligned: "sk-unal-0123456789abcdef",
  respan: "rsp-0123456789abcdef0123",
  silkcompute: "sk-0123456789abcdef0123",
} as const;

const silkcomputeCatalog = {
  object: "list",
  data: [
    {
      id: "deepseek-v4.1-flash-1017-uncensored",
      object: "model",
      owned_by: "silkcompute",
      context_length: 1_048_576,
      max_completion_tokens: 131_072,
      reasoning_efforts: ["none", "low", "high", "max"],
    },
    {
      id: "hy4-uncensored",
      object: "model",
      owned_by: "silkcompute",
      context_length: 1_048_576,
      max_completion_tokens: 65_536,
      reasoning_efforts: ["none", "low", "high", "max"],
    },
    {
      id: "kimi-k3.1-pro-uncensored",
      object: "model",
      owned_by: "silkcompute",
      context_length: 1_048_576,
      max_completion_tokens: 943_718,
      reasoning_efforts: ["none", "low", "high", "max"],
    },
    {
      id: "glm-5.3-uncensored",
      object: "model",
      owned_by: "silkcompute",
      context_length: 1_048_576,
      max_completion_tokens: 131_072,
      reasoning_efforts: ["low", "high"],
    },
    {
      id: "plain-model",
      object: "model",
      owned_by: "silkcompute",
      context_length: 524_288,
    },
  ],
};

const refuselessCatalog = {
  object: "list",
  data: [
    {
      id: "glm-5.3-abliterated",
      object: "model",
      owned_by: "refuseless",
      abliterated: true,
      vision: false,
      context_length: 1_048_576,
      reasoning_efforts: ["low", "high", "max"],
      reasoning_default: "low",
    },
    {
      id: "deepseek-v4.1-flash-abliterated",
      object: "model",
      owned_by: "refuseless",
      abliterated: true,
      vision: false,
      context_length: 1_048_576,
      reasoning_efforts: ["off", "low", "high", "max"],
      reasoning_default: "low",
    },
    {
      id: "deepseek-v4.1-flash-abliterated-free",
      object: "model",
      owned_by: "refuseless",
      context_length: 524_288,
      reasoning_efforts: ["off", "low", "high", "max"],
    },
    {
      id: "kimi-k3-abliterated",
      object: "model",
      owned_by: "refuseless",
      vision: false,
      context_length: 262_144,
    },
    {
      id: "glm-5.3-flash-abliterated",
      object: "model",
      owned_by: "refuseless",
      vision: true,
      context_length: 1_048_576,
      reasoning_efforts: ["low", "high", "max"],
    },
  ],
};

const unrestrictedCatalog = {
  object: "list",
  data: [
    {
      id: "qwen3.8-27b-uncensored",
      object: "model",
      context_length: 262_144,
      max_output_tokens: 32_768,
      input_modalities: ["text"],
    },
    {
      id: "mimo-v2.6-flash-uncensored",
      object: "model",
      context_length: 1_048_576,
      max_output_tokens: 65_536,
      input_modalities: ["text", "image"],
    },
  ],
};

const unalignedCatalog = {
  models: [
    {
      id: "gpt-6-luna",
      context: 1_050_000,
      max_output: 128_000,
      vision: true,
      reasoning: true,
      status: "up",
    },
    {
      id: "glm-5.3-uncensored",
      context: 1_000_000,
      max_output: 65_536,
      vision: false,
      reasoning: true,
      status: "up",
    },
    {
      id: "kimi-k3",
      context: 500_000,
      max_output: 32_000,
      vision: false,
      reasoning: false,
      status: "degraded",
    },
  ],
};

const respanCatalog = {
  object: "list",
  data: [
    {
      id: "gpt-5.5",
      object: "model",
      owned_by: "openai",
      context_length: 1_000_000,
      pricing: { input_price_unit: "token", output_price_unit: "token" },
    },
    {
      id: "claude-sonnet-4.5",
      object: "model",
      owned_by: "anthropic",
      context_length: 200_000,
      pricing: { input_price_unit: "token", output_price_unit: "token" },
    },
    {
      id: "azure_openai/gpt-4o",
      object: "model",
      owned_by: "azure_openai",
      context_length: null,
      pricing: { input_price_unit: "token", output_price_unit: "token" },
    },
    {
      id: "text-embedding-3-small",
      object: "model",
      context_length: 8_191,
      pricing: { input_price_unit: "token", output_price_unit: "token" },
    },
    {
      id: "flux-pro",
      object: "model",
      pricing: { input_price_unit: "token", output_price_unit: "image" },
    },
    {
      id: "scribe-v1",
      object: "model",
      pricing: { input_price_unit: "minute", output_price_unit: "token" },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function completionResponse(usage: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id: "c1",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "done", reasoning_content: "thinking" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, ...usage },
  });
}

const history: ChatMessage[] = [
  { role: "system", content: "stable system prompt" },
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
];

function request(
  provider: ProviderId,
  model: string,
  extra: Partial<CompletionRequest> = {},
): CompletionRequest {
  return { provider, model, messages: history, ...extra };
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function cacheMarkCount(body: Record<string, unknown>): number {
  return (body.messages as Array<Record<string, unknown>>).reduce((total, message) => {
    const parts = Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
      : [];
    return total + parts.filter((part) => part.cache_control !== undefined).length;
  }, 0);
}

function stubFetch(handler: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => handler());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function loadCatalog(
  provider: ProviderId,
  catalog: unknown,
): Promise<string[]> {
  stubFetch(() => jsonResponse(catalog));
  return providers[provider].listModels!({ apiKey: KEYS[provider as keyof typeof KEYS] });
}

beforeEach(() => {
  resetRefuselessModelCache();
  resetUnrestrictedModelCache();
  resetUnalignedModelCache();
  resetRespanModelCache();
  resetSilkComputeModelCache();
  clearModelCatalogFacts();
  clearProviderModelKnowledge();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("catalog provider registration", () => {
  it.each([
    ["refuseless", "Refuseless", "REFUSELESS_API_KEY", "deepseek-v4.1-flash-abliterated", ["refuseless.com"]],
    ["unrestricted", "Unrestricted", "UNRESTRICTED_API_KEY", "qwen3.8-27b-uncensored", ["Unrestricted.sh"]],
    ["unaligned", "Unaligned", "UNALIGNED_API_KEY", "gpt-6-luna", ["unaligned.pw"]],
    ["respan", "Respan", "RESPAN_API_KEY", "gpt-5.5", ["respan.ai", "Respan-Gateway"]],
    ["silkcompute", "Silk Compute", "SILK_API_KEY", "deepseek-v4.1-flash-1017-uncensored", ["silkcompute.com", "Silk-Compute", "silk"]],
  ] as const)(
    "%s is a first-class endpoint provider",
    (id, displayName, envVar, defaultModel, aliases) => {
      expect(providers[id].id).toBe(id);
      expect(providers[id].displayName).toBe(displayName);
      expect(providers[id].envVar).toBe(envVar);
      expect(providers[id].defaultModel).toBe(defaultModel);
      expect(getDefaultModel(id)).toBe(defaultModel);
      expect(normalizeProvider(id)).toBe(id);
      for (const alias of aliases) expect(normalizeProvider(alias)).toBe(id);
      expect(resolveProviderCategory(id)).toBe("paid-cloud");
      expect(providerUsesEndpoints(id)).toBe(true);
      expect(getKnownModels(id)).toContain(defaultModel);
    },
  );

  it("validates the documented key shapes", () => {
    expect(unrestrictedProvider.validateKey(KEYS.unrestricted)).toBe(true);
    expect(unrestrictedProvider.validateKey(`  ${KEYS.unrestricted}\n`)).toBe(true);
    expect(unrestrictedProvider.validateKey(KEYS.unaligned)).toBe(false);
    expect(unrestrictedProvider.validateKey("unr_sk_")).toBe(false);
    expect(unalignedProvider.validateKey(KEYS.unaligned)).toBe(true);
    expect(unalignedProvider.validateKey(KEYS.unrestricted)).toBe(false);
    for (const provider of [refuselessProvider, respanProvider]) {
      expect(provider.validateKey("0123456789abcdef0123")).toBe(true);
      expect(provider.validateKey("short")).toBe(false);
      expect(provider.validateKey("has a space 0123456789")).toBe(false);
    }
    expect(silkcomputeProvider.validateKey(KEYS.silkcompute)).toBe(true);
    expect(silkcomputeProvider.validateKey(`  ${KEYS.silkcompute}\n`)).toBe(true);
    expect(silkcomputeProvider.validateKey("sk-short")).toBe(false);
    expect(silkcomputeProvider.validateKey("0123456789abcdef0123456789")).toBe(false);
  });
});

describe("Refuseless", () => {
  it("reads limits, vision and reasoning levels from the live catalog", async () => {
    const fetchMock = stubFetch(() => jsonResponse(refuselessCatalog));

    const models = await refuselessProvider.listModels!({ apiKey: KEYS.refuseless });

    expect(models).toEqual([...refuselessCatalog.data.map((entry) => entry.id)].sort());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.refuseless.com/v1/models");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe(
      `Bearer ${KEYS.refuseless}`,
    );
    expect(modelContextWindow("glm-5.3-abliterated", "refuseless")).toBe(1_048_576);
    expect(modelContextWindow("deepseek-v4.1-flash-abliterated-free", "refuseless")).toBe(524_288);
    expect(displayReasoningEfforts("refuseless", "glm-5.3-abliterated")).toEqual(["low", "high", "max"]);
    expect(displayReasoningEfforts("refuseless", "deepseek-v4.1-flash-abliterated")).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
    expect(modelCatalogFacts("refuseless", "deepseek-v4.1-flash-abliterated")?.reasoning?.defaultEffort).toBe(
      "low",
    );
  });

  it("treats models without an off level as always reasoning", async () => {
    await loadCatalog("refuseless", refuselessCatalog);

    expect(routeReasoningIsMandatory("refuseless", "glm-5.3-abliterated")).toBe(true);
    expect(routeReasoningIsMandatory("refuseless", "deepseek-v4.1-flash-abliterated")).toBe(false);
    const forced = resolveBuiltInProfile({ provider: "refuseless", model: "glm-5.3-abliterated" });
    expect(forced.reasoning.generation).toBe("mandatory");
    expect(forced.reasoning.disable).toBe("unsupported");
    expect(forced.reasoning.acceptedEfforts).toEqual(["low", "high", "max"]);
    const optional = resolveBuiltInProfile({ provider: "refuseless", model: "deepseek-v4.1-flash-abliterated" });
    expect(optional.reasoning.generation).toBe("optional");
    expect(optional.reasoning.disableForm).toBe("effort-none");
  });

  it("trusts the catalog image flag over model-name heuristics", async () => {
    await loadCatalog("refuseless", refuselessCatalog);

    expect(modelVisionSupport("refuseless", "glm-5.3-flash-abliterated")).toBe("yes");
    expect(modelVisionSupport("refuseless", "kimi-k3-abliterated")).toBe("no");
    expect(modelVisionSupport("refuseless", "glm-5.3-abliterated")).toBe("no");
  });

  it("maps requested efforts onto the levels each model accepts", async () => {
    await loadCatalog("refuseless", refuselessCatalog);
    const fetchMock = stubFetch(() => completionResponse());

    await refuselessProvider.complete(
      request("refuseless", "glm-5.3-abliterated", { thinking: { enabled: true, effort: "xhigh" } }),
      { apiKey: KEYS.refuseless },
    );
    expect(sentBody(fetchMock).reasoning_effort).toBe("max");

    await refuselessProvider.complete(
      request("refuseless", "glm-5.3-abliterated", { thinking: { enabled: true, effort: "medium" } }),
      { apiKey: KEYS.refuseless },
    );
    expect(sentBody(fetchMock).reasoning_effort).toBe("high");

    await refuselessProvider.complete(
      request("refuseless", "glm-5.3-abliterated", { thinking: { enabled: false, effort: "medium" } }),
      { apiKey: KEYS.refuseless },
    );
    expect(sentBody(fetchMock).reasoning_effort).toBe("low");
  });

  it("turns reasoning off with the none level where the model allows it", async () => {
    await loadCatalog("refuseless", refuselessCatalog);
    const fetchMock = stubFetch(() => completionResponse());

    await refuselessProvider.complete(
      request("refuseless", "deepseek-v4.1-flash-abliterated", { thinking: { enabled: false, effort: "medium" } }),
      { apiKey: KEYS.refuseless },
    );

    expect(sentBody(fetchMock).reasoning_effort).toBe("none");
  });

  it("posts bearer-authenticated chat completions without cache-control extras", async () => {
    const fetchMock = stubFetch(() => completionResponse({ prompt_tokens_details: { cached_tokens: 64 } }));

    const result = await refuselessProvider.complete(
      request("refuseless", "deepseek-v4.1-flash-abliterated"),
      { apiKey: KEYS.refuseless },
    );

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("https://api.refuseless.com/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEYS.refuseless}`);
    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(result.text).toBe("done");
    expect(result.usage?.cachedPromptTokens).toBe(64);
    expect(result.reasoningBlock?.text).toBe("thinking");
  });

  it("validates the key against the catalog endpoint on ping", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ error: { code: "invalid_key", message: "Invalid API key." } }, 401),
    );

    await expect(refuselessProvider.ping({ apiKey: KEYS.refuseless })).rejects.toThrow(/401|Invalid/);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.refuseless.com/v1/models");
    await expect(refuselessProvider.ping({})).rejects.toThrow(/Refuseless API key is required/);
  });
});

describe("Unrestricted", () => {
  it("reads context, output limits and image input from the catalog", async () => {
    const fetchMock = stubFetch(() => jsonResponse(unrestrictedCatalog));

    const models = await unrestrictedProvider.listModels!({ apiKey: KEYS.unrestricted });

    expect(models).toEqual(["mimo-v2.6-flash-uncensored", "qwen3.8-27b-uncensored"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.unrestricted.sh/v1/models");
    expect(modelContextWindow("qwen3.8-27b-uncensored", "unrestricted")).toBe(262_144);
    expect(modelContextWindow("mimo-v2.6-flash-uncensored", "unrestricted")).toBe(1_048_576);
    expect(modelCatalogFacts("unrestricted", "qwen3.8-27b-uncensored")?.maxOutputTokens).toBe(32_768);
    expect(modelVisionSupport("unrestricted", "qwen3.8-27b-uncensored")).toBe("no");
    expect(modelVisionSupport("unrestricted", "mimo-v2.6-flash-uncensored")).toBe("yes");
  });

  it("uses the standard effort ladder and the none level to disable thinking", async () => {
    await loadCatalog("unrestricted", unrestrictedCatalog);
    const fetchMock = stubFetch(() => completionResponse());

    await unrestrictedProvider.complete(
      request("unrestricted", "qwen3.8-27b-uncensored", { thinking: { enabled: true, effort: "xhigh" } }),
      { apiKey: KEYS.unrestricted },
    );
    expect(sentBody(fetchMock).reasoning_effort).toBe("xhigh");

    await unrestrictedProvider.complete(
      request("unrestricted", "qwen3.8-27b-uncensored", { thinking: { enabled: false, effort: "medium" } }),
      { apiKey: KEYS.unrestricted },
    );
    expect(sentBody(fetchMock).reasoning_effort).toBe("none");
    const [url] = fetchMock.mock.calls.at(-1) as [string];
    expect(url).toBe("https://api.unrestricted.sh/v1/chat/completions");
  });

  it("surfaces a revoked key from the catalog even when a stale list is cached", async () => {
    stubFetch(() => jsonResponse(unrestrictedCatalog));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await unrestrictedProvider.listModels!({ apiKey: KEYS.unrestricted });

    now.mockReturnValue(1_000 + 10 * 60 * 1000);
    stubFetch(() => jsonResponse({ error: { code: "invalid_api_key", message: "Invalid or revoked API key." } }, 401));
    await expect(unrestrictedProvider.listModels!({ apiKey: KEYS.unrestricted })).rejects.toThrow(
      /401|Invalid/,
    );

    stubFetch(() => jsonResponse({ error: { message: "down" } }, 503));
    await expect(unrestrictedProvider.listModels!({ apiKey: KEYS.unrestricted })).resolves.toEqual([
      "mimo-v2.6-flash-uncensored",
      "qwen3.8-27b-uncensored",
    ]);
  });
});

describe("Unaligned", () => {
  it("reads the public native catalog for limits, vision and reasoning", async () => {
    const fetchMock = stubFetch(() => jsonResponse(unalignedCatalog));

    const models = await unalignedProvider.listModels!({ apiKey: KEYS.unaligned });

    expect(models).toEqual(["glm-5.3-uncensored", "gpt-6-luna", "kimi-k3"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.unaligned.pw/v1/models");
    expect(modelContextWindow("gpt-6-luna", "unaligned")).toBe(1_050_000);
    expect(modelCatalogFacts("unaligned", "gpt-6-luna")?.maxOutputTokens).toBe(128_000);
    expect(modelVisionSupport("unaligned", "gpt-6-luna")).toBe("yes");
    expect(modelVisionSupport("unaligned", "kimi-k3")).toBe("no");
    expect(modelCatalogFacts("unaligned", "kimi-k3")?.reasoning?.supported).toBe(false);
    expect(modelCatalogFacts("unaligned", "gpt-6-luna")?.reasoning?.supported).toBe(true);
  });

  it("lists models without a key and follows a custom base URL", async () => {
    const fetchMock = stubFetch(() => jsonResponse(unalignedCatalog));

    await unalignedProvider.listModels!({});
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).has("authorization")).toBe(false);

    resetUnalignedModelCache();
    await unalignedProvider.listModels!({ baseUrl: "https://gateway.example.com/openai/v1" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://gateway.example.com/v1/models");

    resetUnalignedModelCache();
    await unalignedProvider.listModels!({ baseUrl: "https://proxy.example.com/v1" });
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("https://proxy.example.com/v1/models");
  });

  it("sends the OpenAI-format request with a session cache key", async () => {
    await loadCatalog("unaligned", unalignedCatalog);
    const fetchMock = stubFetch(() => completionResponse());

    await unalignedProvider.complete(request("unaligned", "gpt-6-luna"), { apiKey: KEYS.unaligned });

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("https://api.unaligned.pw/openai/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEYS.unaligned}`);
    expect(typeof sentBody(fetchMock).prompt_cache_key).toBe("string");
    expect(cacheMarkCount(sentBody(fetchMock))).toBe(0);
  });

  it("sends no reasoning control to models the catalog marks as non-reasoning", async () => {
    await loadCatalog("unaligned", unalignedCatalog);
    const fetchMock = stubFetch(() => completionResponse());

    await unalignedProvider.complete(
      request("unaligned", "kimi-k3", { thinking: { enabled: true, effort: "high" } }),
      { apiKey: KEYS.unaligned },
    );

    expect(sentBody(fetchMock)).not.toHaveProperty("reasoning_effort");
  });
});

describe("Respan", () => {
  it("keeps token-priced chat models and reads context windows from the gateway catalog", async () => {
    const fetchMock = stubFetch(() => jsonResponse(respanCatalog));

    const models = await respanProvider.listModels!({ apiKey: KEYS.respan });

    expect(models).toEqual(["azure_openai/gpt-4o", "claude-sonnet-4.5", "gpt-5.5"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.respan.ai/api/v1/models");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe(
      `Bearer ${KEYS.respan}`,
    );
    expect(modelContextWindow("gpt-5.5", "respan")).toBe(1_000_000);
    expect(modelContextWindow("claude-sonnet-4.5", "respan")).toBe(200_000);
    expect(modelCatalogFacts("respan", "azure_openai/gpt-4o")?.contextTokens).toBeUndefined();
  });

  it("reads a custom gateway catalog from its own models route", async () => {
    const fetchMock = stubFetch(() => jsonResponse(respanCatalog));

    await respanProvider.listModels!({ apiKey: KEYS.respan, baseUrl: "https://gateway.example.com" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://gateway.example.com/v1/models");
  });

  it("marks Claude requests with content-block cache controls", async () => {
    const fetchMock = stubFetch(() => sseResponse([
      { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: "stop" }] },
      {
        id: "c1",
        choices: [],
        usage: {
          prompt_tokens: 12_000,
          completion_tokens: 8,
          total_tokens: 12_008,
          prompt_tokens_details: { cached_tokens: 9_000, cache_write_tokens: 2_000 },
        },
      },
    ]));

    const result = await respanProvider.stream!(
      request("respan", "claude-sonnet-4.5"),
      { apiKey: KEYS.respan },
      () => {},
    );

    const [url] = fetchMock.mock.calls.at(-1) as [string];
    expect(url).toBe("https://gateway.respan.ai/v1/chat/completions");
    const body = sentBody(fetchMock);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.every((message) => !("cache_control" in message))).toBe(true);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "stable system prompt", cache_control: { type: "ephemeral" } },
    ]);
    expect(cacheMarkCount(body)).toBeGreaterThan(0);
    expect(cacheMarkCount(body)).toBeLessThanOrEqual(4);
    expect(result.usage?.cachedPromptTokens).toBe(9_000);
    expect(result.usage?.cacheCreationTokens).toBe(2_000);
  });

  it("gives other models a session cache key instead of cache marks", async () => {
    const fetchMock = stubFetch(() => completionResponse({ prompt_cache_hit_tokens: 40 }));

    const result = await respanProvider.complete(request("respan", "gpt-5.5"), { apiKey: KEYS.respan });

    const body = sentBody(fetchMock);
    expect(typeof body.prompt_cache_key).toBe("string");
    expect(cacheMarkCount(body)).toBe(0);
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(result.usage?.cachedPromptTokens).toBe(40);
  });

  it("keeps the shared prompt prefix identical and the cache key stable as the conversation grows", async () => {
    const fetchMock = stubFetch(() => completionResponse());
    const grown: ChatMessage[] = [
      ...history,
      { role: "assistant", content: "second answer" },
      { role: "user", content: "third question" },
    ];

    await respanProvider.complete(request("respan", "gpt-5.5"), { apiKey: KEYS.respan });
    const first = sentBody(fetchMock);
    await respanProvider.complete(request("respan", "gpt-5.5", { messages: grown }), { apiKey: KEYS.respan });
    const second = sentBody(fetchMock);

    const firstMessages = first.messages as unknown[];
    expect((second.messages as unknown[]).slice(0, firstMessages.length)).toEqual(firstMessages);
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
  });

  it("forwards the selected effort for reasoning models", async () => {
    const fetchMock = stubFetch(() => completionResponse());

    await respanProvider.complete(
      request("respan", "gpt-5.5", { thinking: { enabled: true, effort: "high" } }),
      { apiKey: KEYS.respan },
    );

    expect(sentBody(fetchMock).reasoning_effort).toBe("high");
  });
});

describe("Silk Compute", () => {
  it("reads context, output limits and reasoning levels from the key-gated catalog", async () => {
    const fetchMock = stubFetch(() => jsonResponse(silkcomputeCatalog));

    const models = await silkcomputeProvider.listModels!({ apiKey: KEYS.silkcompute });

    expect(models).toEqual(silkcomputeCatalog.data.map((entry) => entry.id).sort());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.silkcompute.com/v1/models");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe(
      `Bearer ${KEYS.silkcompute}`,
    );
    expect(modelContextWindow("kimi-k3.1-pro-uncensored", "silkcompute")).toBe(1_048_576);
    expect(modelContextWindow("plain-model", "silkcompute")).toBe(524_288);
    expect(modelCatalogFacts("silkcompute", "kimi-k3.1-pro-uncensored")?.maxOutputTokens).toBe(943_718);
    expect(modelCatalogFacts("silkcompute", "hy4-uncensored")?.maxOutputTokens).toBe(65_536);
    expect(displayReasoningEfforts("silkcompute", "hy4-uncensored")).toEqual(["none", "low", "high", "max"]);
    expect(displayReasoningEfforts("silkcompute", "glm-5.3-uncensored")).toEqual(["low", "high"]);
  });

  it("treats none as a selectable level and a missing none as always-on reasoning", async () => {
    await loadCatalog("silkcompute", silkcomputeCatalog);

    expect(routeReasoningIsMandatory("silkcompute", "hy4-uncensored")).toBe(false);
    expect(routeReasoningIsMandatory("silkcompute", "glm-5.3-uncensored")).toBe(true);
    const optional = resolveBuiltInProfile({ provider: "silkcompute", model: "hy4-uncensored" });
    expect(optional.reasoning.generation).toBe("optional");
    expect(optional.reasoning.disableForm).toBe("effort-none");
    expect(optional.reasoning.replayScope).toBe("tool-turn");
    const forced = resolveBuiltInProfile({ provider: "silkcompute", model: "glm-5.3-uncensored" });
    expect(forced.reasoning.generation).toBe("mandatory");
    expect(forced.reasoning.acceptedEfforts).toEqual(["low", "high"]);
  });

  it("falls back to the global effort ladder for a model that publishes no levels", async () => {
    await loadCatalog("silkcompute", silkcomputeCatalog);
    const fetchMock = stubFetch(() => completionResponse());

    await silkcomputeProvider.complete(
      request("silkcompute", "plain-model", { thinking: { enabled: true, effort: "xhigh" } }),
      { apiKey: KEYS.silkcompute },
    );

    expect(sentBody(fetchMock).reasoning_effort).toBe("xhigh");
  });

  it("maps requested efforts onto the nearest level a model accepts", async () => {
    await loadCatalog("silkcompute", silkcomputeCatalog);
    const fetchMock = stubFetch(() => completionResponse());
    const sendEffort = async (effort: "minimal" | "medium" | "xhigh"): Promise<unknown> => {
      await silkcomputeProvider.complete(
        request("silkcompute", "hy4-uncensored", { thinking: { enabled: true, effort } }),
        { apiKey: KEYS.silkcompute },
      );
      return sentBody(fetchMock).reasoning_effort;
    };

    expect(await sendEffort("minimal")).toBe("low");
    expect(await sendEffort("medium")).toBe("high");
    expect(await sendEffort("xhigh")).toBe("max");
  });

  it("sends none when thinking is switched off", async () => {
    await loadCatalog("silkcompute", silkcomputeCatalog);
    const fetchMock = stubFetch(() => completionResponse());

    await silkcomputeProvider.complete(
      request("silkcompute", "deepseek-v4.1-flash-1017-uncensored", {
        thinking: { enabled: false, effort: "medium" },
      }),
      { apiKey: KEYS.silkcompute },
    );

    expect(sentBody(fetchMock).reasoning_effort).toBe("none");
  });

  it("offers only the levels the latest catalog publishes", async () => {
    await loadCatalog("silkcompute", silkcomputeCatalog);
    expect(displayReasoningEfforts("silkcompute", "hy4-uncensored")).toContain("max");

    resetSilkComputeModelCache();
    await loadCatalog("silkcompute", {
      data: [
        {
          id: "hy4-uncensored",
          context_length: 1_048_576,
          reasoning_efforts: ["none", "low", "high"],
        },
      ],
    });

    expect(displayReasoningEfforts("silkcompute", "hy4-uncensored")).toEqual(["none", "low", "high"]);
  });

  it("sends images to the models that take them and leaves the rest unclassified", async () => {
    await loadCatalog("silkcompute", silkcomputeCatalog);

    expect(modelVisionSupport("silkcompute", "kimi-k3.1-pro-uncensored")).toBe("yes");
    expect(modelVisionSupport("silkcompute", "hy4-uncensored")).toBe("yes");
    expect(modelVisionSupport("silkcompute", "deepseek-v4.1-flash-1017-uncensored")).toBe("unknown");
    expect(modelVisionSupport("silkcompute", "glm-5.3-uncensored")).toBe("unknown");
  });

  it("posts bearer-authenticated chat completions with an unchanged prefix and no cache extras", async () => {
    const fetchMock = stubFetch(() =>
      completionResponse({ prompt_tokens_details: { cached_tokens: 96 } }),
    );
    const grown: ChatMessage[] = [
      ...history,
      { role: "assistant", content: "second answer" },
      { role: "user", content: "third question" },
    ];

    const first = await silkcomputeProvider.complete(
      request("silkcompute", "hy4-uncensored"),
      { apiKey: KEYS.silkcompute },
    );
    const firstBody = sentBody(fetchMock);
    await silkcomputeProvider.complete(
      request("silkcompute", "hy4-uncensored", { messages: grown }),
      { apiKey: KEYS.silkcompute },
    );
    const secondBody = sentBody(fetchMock);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.silkcompute.com/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEYS.silkcompute}`);
    for (const body of [firstBody, secondBody]) {
      expect(body).not.toHaveProperty("prompt_cache_key");
      expect(JSON.stringify(body)).not.toContain("cache_control");
    }
    const firstMessages = firstBody.messages as unknown[];
    expect((secondBody.messages as unknown[]).slice(0, firstMessages.length)).toEqual(firstMessages);
    expect(first.usage?.cachedPromptTokens).toBe(96);
    expect(first.reasoningBlock?.text).toBe("thinking");
  });

  it("streams reasoning and answer deltas and reads cached tokens from the usage chunk", async () => {
    const fetchMock = stubFetch(() =>
      sseResponse([
        { id: "c1", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "weigh " } }] },
        { id: "c1", choices: [{ index: 0, delta: { reasoning_content: "options" } }] },
        { id: "c1", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] },
        {
          id: "c1",
          choices: [],
          usage: {
            prompt_tokens: 5_000,
            completion_tokens: 20,
            total_tokens: 5_020,
            prompt_tokens_details: { cached_tokens: 4_096 },
          },
        },
      ]),
    );
    const events: Array<{ type: string; text?: string }> = [];
    const tokens: string[] = [];

    const result = await silkcomputeProvider.stream!(
      request("silkcompute", "kimi-k3.1-pro-uncensored", {
        thinking: { enabled: true, effort: "max" },
        onStreamEvent: (event: { type: string; text?: string }) => events.push(event),
      } as Partial<CompletionRequest>),
      { apiKey: KEYS.silkcompute },
      (token) => tokens.push(token),
    );

    expect(sentBody(fetchMock).stream).toBe(true);
    expect(sentBody(fetchMock).reasoning_effort).toBe("max");
    expect(
      events.filter((event) => event.type === "reasoning_delta").map((event) => event.text),
    ).toEqual(["weigh ", "options"]);
    expect(tokens.join("")).toBe("Hello");
    expect(result.reasoningBlock?.text).toBe("weigh options");
    expect(result.usage?.cachedPromptTokens).toBe(4_096);
  });

  it("surfaces a rejected key from the catalog and from ping, and refuses to ping without one", async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { message: "Invalid API key provided.", type: "authentication_error", code: "invalid_api_key" } },
        401,
      ),
    );

    await expect(silkcomputeProvider.listModels!({ apiKey: KEYS.silkcompute })).rejects.toThrow(/401|Invalid/);
    await expect(silkcomputeProvider.ping({ apiKey: KEYS.silkcompute })).rejects.toThrow(/401|Invalid/);
    await expect(silkcomputeProvider.ping({})).rejects.toThrow(/Silk Compute API key is required/);
  });

  it("reports an empty balance as a typed 402 so credentials can rotate", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            message: "Insufficient credits. Add credits to your account to continue.",
            type: "invalid_request_error",
            code: "insufficient_credits",
          },
        },
        402,
      ),
    );

    await expect(
      silkcomputeProvider.complete(request("silkcompute", "hy4-uncensored"), { apiKey: KEYS.silkcompute }),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("normalises a bare host override to its /v1 route", async () => {
    const fetchMock = stubFetch(() => jsonResponse(silkcomputeCatalog));

    await silkcomputeProvider.listModels!({ apiKey: KEYS.silkcompute, baseUrl: "https://api.silkcompute.com" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.silkcompute.com/v1/models");
  });
});
