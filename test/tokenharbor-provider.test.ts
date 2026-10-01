import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultModel, normalizeProvider } from "../src/llm/provider.js";
import { providers } from "../src/llm/routing/provider-selection.js";
import { resolveProviderCategory } from "../src/store/config.js";
import { modelContextWindow } from "../src/llm/context-windows.js";
import {
  catalogAdvertisedEfforts,
  displayReasoningEfforts,
  modelCatalogFacts,
} from "../src/llm/capabilities.js";
import {
  TOKENHARBOR_CACHE_CONTROL_HEADER,
  TOKENHARBOR_DEFAULT_BASE_URL,
  chatCapableCatalog,
  resetTokenHarborModelCache,
  tokenharborProvider,
} from "../src/llm/tokenharbor.js";
import {
  tokenHarborBreakpointMode,
  tokenHarborCacheStrategy,
} from "../src/llm/tokenharbor-cache.js";
import type { ChatMessage, CompletionRequest } from "../src/types.js";

const KEY = `thk_live_${"a1B2c3D4".repeat(8)}`;

const catalog = {
  object: "list",
  data: [
    {
      id: "claude-sonnet-5.5",
      object: "model",
      context_length: 1_000_000,
      reasoning_levels: ["low", "medium", "high", "xhigh"],
      inputModalities: ["text", "image", "file"],
      outputModalities: ["text"],
    },
    {
      id: "gpt-6.1-sol",
      object: "model",
      context_window: 400_000,
      max_output_tokens: 128_000,
      reasoning: { supported_efforts: ["low", "high"] },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    { id: "gpt-image-2", outputModalities: ["image"] },
    { id: "text-embedding-4" },
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

function streamEvents(): Array<Record<string, unknown>> {
  return [
    { id: "c1", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "weighing " } }] },
    { id: "c1", choices: [{ index: 0, delta: { reasoning_content: "options" } }] },
    { id: "c1", choices: [{ index: 0, delta: { content: "Hello" } }] },
    { id: "c1", choices: [{ index: 0, delta: { content: " there" }, finish_reason: "stop" }] },
    {
      id: "c1",
      choices: [],
      usage: {
        prompt_tokens: 12_500,
        completion_tokens: 40,
        total_tokens: 12_540,
        cache_read_input_tokens: 11_000,
        cache_creation_input_tokens: 1_200,
      },
    },
  ];
}

const history: ChatMessage[] = [
  { role: "system", content: "stable system prompt" },
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
];

function request(model: string, extra: Partial<CompletionRequest> = {}): CompletionRequest {
  return { provider: "tokenharbor", model, messages: history, ...extra } as CompletionRequest;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function promptText(message: Record<string, unknown>): string {
  const content = message.content;
  const text = Array.isArray(content)
    ? (content as Array<Record<string, unknown>>).map((part) => String(part.text ?? "")).join("")
    : String(content ?? "");
  return `${String(message.role)}:${text}`;
}

function markCount(body: Record<string, unknown>): number {
  const messages = body.messages as Array<Record<string, unknown>>;
  return messages.reduce((total, message) => {
    const parts = Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
      : [];
    return total + parts.filter((part) => part.cache_control !== undefined).length;
  }, 0);
}

describe("Token Harbor registration", () => {
  it("is a first-class provider with aliases, defaults and category", () => {
    expect(providers.tokenharbor.id).toBe("tokenharbor");
    expect(providers.tokenharbor.displayName).toBe("Token Harbor");
    expect(providers.tokenharbor.envVar).toBe("TOKENHARBOR_API_KEY");
    for (const alias of ["tokenharbor", "Token-Harbor", "tokenharbor.ai"]) {
      expect(normalizeProvider(alias)).toBe("tokenharbor");
    }
    expect(getDefaultModel("tokenharbor")).toBe("claude-sonnet-5.5");
    expect(resolveProviderCategory("tokenharbor")).toBe("paid-cloud");
  });

  it("accepts Universal Keys and rejects foreign key shapes", () => {
    expect(tokenharborProvider.validateKey(KEY)).toBe(true);
    expect(tokenharborProvider.validateKey(`  ${KEY}\n`)).toBe(true);
    expect(tokenharborProvider.validateKey("sk-live-not-a-harbor-key-0000")).toBe(false);
    expect(tokenharborProvider.validateKey("thk_short")).toBe(false);
  });
});

describe("Token Harbor cache strategy", () => {
  it("marks Claude requests explicitly and leaves every other model to the gateway", () => {
    for (const model of ["claude-opus-5.5", "claude-sonnet-5.5-fast", "anthropic/claude-fable-5.1"]) {
      expect(tokenHarborCacheStrategy(model)).toBe("explicit-breakpoints");
      expect(tokenHarborBreakpointMode(model)).toBe("content-block");
    }
    for (const model of ["gpt-6-astra", "kimi-k3", "qwen3.8-max", "muse-spark-1-3", "grok-4.7"]) {
      expect(tokenHarborCacheStrategy(model)).toBe("gateway-managed");
      expect(tokenHarborBreakpointMode(model)).toBeUndefined();
    }
  });
});

describe("Token Harbor catalog", () => {
  it("keeps chat models only, trusting declared output modalities over id heuristics", () => {
    expect(chatCapableCatalog(catalog).data.map((entry) => (entry as { id: string }).id)).toEqual([
      "claude-sonnet-5.5",
      "gpt-6.1-sol",
    ]);
    expect(chatCapableCatalog({ data: ["gpt-image-1", "kimi-k3"] }).data).toEqual(["kimi-k3"]);
    expect(chatCapableCatalog({ data: ["whisper-2"] }).data).toEqual(["whisper-2"]);
  });
});

describe("Token Harbor provider", () => {
  beforeEach(() => resetTokenHarborModelCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("discovers models live with the key and registers limits, efforts and vision", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(catalog));
    vi.stubGlobal("fetch", fetchMock);

    const models = await tokenharborProvider.listModels!({ apiKey: KEY });

    expect(models).toEqual(["claude-sonnet-5.5", "gpt-6.1-sol"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${TOKENHARBOR_DEFAULT_BASE_URL}/models`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
    });
    expect(modelContextWindow("claude-sonnet-5.5", "tokenharbor")).toBe(1_000_000);
    expect(modelContextWindow("gpt-6.1-sol", "tokenharbor")).toBe(400_000);
    expect(modelCatalogFacts("tokenharbor", "claude-sonnet-5.5")?.vision).toBe(true);
    expect(catalogAdvertisedEfforts("tokenharbor", "claude-sonnet-5.5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(displayReasoningEfforts("tokenharbor", "gpt-6.1-sol")).toEqual(["low", "high"]);
  });

  it("caches the catalog and falls back to it when a refresh fails", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(catalog));
    vi.stubGlobal("fetch", fetchMock);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    await tokenharborProvider.listModels!({ apiKey: KEY });
    await tokenharborProvider.listModels!({ apiKey: KEY });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000 + 31 * 60 * 1000);
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: { message: "down" } }, 503));
    await expect(tokenharborProvider.listModels!({ apiKey: KEY })).resolves.toEqual([
      "claude-sonnet-5.5",
      "gpt-6.1-sol",
    ]);
  });

  it("requires a key and surfaces gateway rejections", async () => {
    await expect(tokenharborProvider.listModels!({})).rejects.toThrow(/Token Harbor API key/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "Invalid or revoked API key.", code: "invalid_api_key" } }, 401),
      ),
    );
    await expect(tokenharborProvider.listModels!({ apiKey: KEY })).rejects.toThrow(/401|Invalid/);
  });

  it("honours a base URL override", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(catalog));
    vi.stubGlobal("fetch", fetchMock);
    await tokenharborProvider.listModels!({ apiKey: KEY, baseUrl: "https://gateway.example.com" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://gateway.example.com/v1/models");
  });

  it("streams Claude over chat completions with content-block cache marks and gateway cache bypass", async () => {
    const fetchMock = vi.fn(async () => sseResponse(streamEvents()));
    vi.stubGlobal("fetch", fetchMock);
    const tokens: string[] = [];

    const result = await tokenharborProvider.stream!(
      request("claude-sonnet-5.5"),
      { apiKey: KEY },
      (token) => tokens.push(token),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TOKENHARBOR_DEFAULT_BASE_URL}/chat/completions`);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get(TOKENHARBOR_CACHE_CONTROL_HEADER)).toBe("bypass");
    const body = sentBody(fetchMock);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(messages.every((message) => !("cache_control" in message))).toBe(true);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "stable system prompt", cache_control: { type: "ephemeral" } },
    ]);
    expect(messages.at(-1)?.content).toEqual([
      { type: "text", text: "second question", cache_control: { type: "ephemeral" } },
    ]);
    expect(markCount(body)).toBeGreaterThan(0);
    expect(markCount(body)).toBeLessThanOrEqual(4);

    expect(tokens.join("")).toBe("Hello there");
    expect(result.text).toBe("Hello there");
    expect(result.api).toBe("chat-completions");
    expect(result.usage?.cachedPromptTokens).toBe(11_000);
    expect(result.usage?.cacheCreationTokens).toBe(1_200);
  });

  it("streams reasoning live and forwards the selected effort untouched", async () => {
    const fetchMock = vi.fn(async () => sseResponse(streamEvents()));
    vi.stubGlobal("fetch", fetchMock);
    const events: Array<{ type: string; text?: string }> = [];

    const result = await tokenharborProvider.stream!(
      request("claude-sonnet-5.5", {
        thinking: { enabled: true, effort: "xhigh" },
        onStreamEvent: (event: { type: string; text?: string }) => events.push(event),
      } as Partial<CompletionRequest>),
      { apiKey: KEY },
      () => {},
    );

    expect(sentBody(fetchMock).reasoning_effort).toBe("xhigh");
    expect(
      events.filter((event) => event.type === "reasoning_delta").map((event) => event.text),
    ).toEqual(["weighing ", "options"]);
    expect(result.reasoningBlock?.text).toBe("weighing options");
    expect(result.reasoningArtifacts?.[0]?.provenance.provider).toBe("tokenharbor");
  });

  it("sends no cache marks for models the gateway caches itself", async () => {
    const fetchMock = vi.fn(async () => sseResponse(streamEvents()));
    vi.stubGlobal("fetch", fetchMock);

    await tokenharborProvider.stream!(request("gpt-6.1-sol"), { apiKey: KEY }, () => {});

    const body = sentBody(fetchMock);
    expect(markCount(body)).toBe(0);
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(body).not.toHaveProperty("prompt_cache_key");
  });

  it("keeps the prompt text of the shared prefix identical as the conversation grows", async () => {
    const fetchMock = vi.fn(async () => sseResponse(streamEvents()));
    vi.stubGlobal("fetch", fetchMock);
    const grown: ChatMessage[] = [
      ...history,
      { role: "assistant", content: "second answer" },
      { role: "user", content: "third question" },
    ];

    await tokenharborProvider.stream!(request("claude-sonnet-5.5"), { apiKey: KEY }, () => {});
    const first = sentBody(fetchMock).messages as Array<Record<string, unknown>>;
    await tokenharborProvider.stream!(
      request("claude-sonnet-5.5", { messages: grown }),
      { apiKey: KEY },
      () => {},
    );
    const second = sentBody(fetchMock).messages as Array<Record<string, unknown>>;

    expect(second.length).toBe(first.length + 2);
    expect(first.map(promptText)).toEqual(second.slice(0, first.length).map(promptText));
  });

  it("completes without streaming through the same route", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "c2",
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tokenharborProvider.complete(request("kimi-k3"), { apiKey: KEY });

    expect(result.text).toBe("done");
    expect(sentBody(fetchMock).stream).toBe(false);
    expect(
      new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get(
        TOKENHARBOR_CACHE_CONTROL_HEADER,
      ),
    ).toBe("bypass");
  });
});
