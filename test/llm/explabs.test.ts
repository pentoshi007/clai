import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  explabsAuthHeaders,
  explabsBaseUrl,
  explabsCatalogUrl,
  explabsFallbackModels,
  explabsProvider,
  resetExplabsCatalogCache,
} from "../../src/llm/explabs.js";
import { defaultModels, envVars, normalizeProvider } from "../../src/llm/provider.js";
import { providers } from "../../src/llm/router.js";
import { providerCategory } from "../../src/store/config.js";
import { providerIds } from "../../src/types.js";
import { getKnownModels } from "../../src/app/commands/catalog.js";
import { getProviderInfoText } from "../../src/llm/provider.js";

const FABLE_ROW = {
  model: {
    slug: "claude-fable-5.1",
    context_window: 1_000_000,
    max_output_tokens: 128_000,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_params: { stop: true, tools: true, reasoning: true },
  },
  providers: [
    {
      provider: "openrouter",
      capabilities: {
        supports_reasoning: true,
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
        reasoning_default_effort: "high",
        supports_temperature: false,
        supports_top_p: false,
      },
    },
  ],
};

function catalogPayload(rows: unknown[] = [FABLE_ROW]) {
  return JSON.stringify({ models: rows, total: rows.length, limit: 500, offset: 0 });
}

function callablePayload(ids: string[] = ["claude-fable-5.1"]) {
  return JSON.stringify({
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "exp" })),
  });
}

function stubCatalogAndCallable(
  rows: unknown[] = [FABLE_ROW],
  ids: string[] = ["claude-fable-5.1"],
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith(explabsCatalogUrl)) {
      return new Response(catalogPayload(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(callablePayload(ids), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("Experiential Labs provider registration", () => {
  it("is a fully registered built-in provider", () => {
    expect(providerIds).toContain("explabs");
    expect(providers.explabs).toBe(explabsProvider);
    expect(defaultModels.explabs).toBe("claude-fable-5.1");
    expect(envVars.explabs).toBe("EXPLABS_API_KEY");
    expect(providerCategory.explabs).toBe("paid-cloud");
  });

  it("resolves every documented alias", () => {
    for (const alias of [
      "explabs",
      "experiential",
      "experientiallabs",
      "experiential-labs",
      "exp",
    ]) {
      expect(normalizeProvider(alias)).toBe("explabs");
    }
  });

  it("exposes the full provider surface", () => {
    expect(typeof explabsProvider.complete).toBe("function");
    expect(typeof explabsProvider.stream).toBe("function");
    expect(typeof explabsProvider.listModels).toBe("function");
    expect(typeof explabsProvider.ping).toBe("function");
    expect(explabsProvider.reasoningStyle).toBe("openai");
  });

  it("targets the OpenAI-compatible gateway surface", () => {
    expect(explabsBaseUrl).toBe("https://api.experientiallabs.ai/v1");
    expect(explabsCatalogUrl).toBe("https://api.experientiallabs.ai/api/models");
  });

  it("authenticates with a single Bearer header, as documented", () => {
    const headers = explabsAuthHeaders("xpl_abcd1234");
    expect(headers.authorization).toBe("Bearer xpl_abcd1234");
    expect(Object.keys(headers)).toEqual(["authorization"]);
  });

  it("validates xpl_ key shapes", () => {
    expect(
      explabsProvider.validateKey?.("xpl_0123456789abcdef0123456789abcdef01234567"),
    ).toBe(true);
    expect(explabsProvider.validateKey?.("xpl_short")).toBe(false);
    expect(explabsProvider.validateKey?.("sk-abcdefgh")).toBe(false);
    expect(explabsProvider.validateKey?.("mg_abcdefgh")).toBe(false);
  });

  it("ships an offline catalog and an info page", () => {
    expect(getKnownModels("explabs").length).toBeGreaterThan(5);
    expect(getKnownModels("explabs")).toContain("claude-fable-5.1");
    const info = getProviderInfoText("explabs");
    expect(info).toContain("api.experientiallabs.ai");
    expect(info).toContain("EXPLABS_API_KEY");
    expect(info).toContain("insufficient_quota");
  });

  it("requires a key for completions, streaming and ping", async () => {
    await expect(explabsProvider.ping?.({ apiKey: undefined })).rejects.toThrow(
      /API key is required/,
    );
    await expect(
      explabsProvider.complete({ messages: [] }, { apiKey: undefined }),
    ).rejects.toThrow(/API key is required/);
    await expect(
      explabsProvider.stream?.({ messages: [] }, { apiKey: undefined }, () => undefined),
    ).rejects.toThrow(/API key is required/);
  });
});

describe("Experiential Labs model discovery", () => {
  afterEach(() => {
    resetExplabsCatalogCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the callable slugs and hides non-chat entries", async () => {
    vi.stubGlobal(
      "fetch",
      stubCatalogAndCallable(
        [FABLE_ROW],
        [
          "claude-fable-5.1",
          "gpt-5.6-sol",
          "chatgpt-image-latest",
          "claude-fable-5.1-batch",
          "text-embedding-4-large",
          "my-org-custom-model",
        ],
      ),
    );
    const models = await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });
    expect(models).toContain("claude-fable-5.1");
    expect(models).toContain("gpt-5.6-sol");
    expect(models).toContain("my-org-custom-model");
    expect(models).not.toContain("chatgpt-image-latest");
    expect(models).not.toContain("claude-fable-5.1-batch");
    expect(models).not.toContain("text-embedding-4-large");
  });

  it("authenticates both the catalog and the callable-models request", async () => {
    const fetchMock = stubCatalogAndCallable();
    vi.stubGlobal("fetch", fetchMock);
    const key = "xpl_0123456789abcdef0123456789abcdef01234567";
    await explabsProvider.listModels!({ apiKey: key });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.startsWith(explabsCatalogUrl))).toBe(true);
    expect(urls).toContain(`${explabsBaseUrl}/models`);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({
        authorization: `Bearer ${key}`,
      });
    }
  });

  it("browses the public catalog without a key and sends no credentials", async () => {
    const fetchMock = stubCatalogAndCallable();
    vi.stubGlobal("fetch", fetchMock);
    const models = await explabsProvider.listModels!({ apiKey: undefined });
    expect(models).toContain("claude-fable-5.1");
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.every((url) => url.startsWith(explabsCatalogUrl))).toBe(true);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toEqual({});
    }
  });

  it("hides image-output rows even when browsing keyless", async () => {
    vi.stubGlobal(
      "fetch",
      stubCatalogAndCallable([
        FABLE_ROW,
        {
          model: {
            slug: "some-image-model",
            input_modalities: ["text"],
            output_modalities: ["image"],
          },
          providers: [],
        },
      ]),
    );
    const models = await explabsProvider.listModels!({ apiKey: undefined });
    expect(models).toContain("claude-fable-5.1");
    expect(models).not.toContain("some-image-model");
  });

  it("caches the catalog instead of refetching per call", async () => {
    const fetchMock = stubCatalogAndCallable();
    vi.stubGlobal("fetch", fetchMock);
    const key = "xpl_0123456789abcdef0123456789abcdef01234567";
    await explabsProvider.listModels!({ apiKey: key });
    const fetchesAfterFirstLoad = fetchMock.mock.calls.length;
    await explabsProvider.listModels!({ apiKey: key });
    await explabsProvider.listModels!({ apiKey: key });
    expect(fetchMock).toHaveBeenCalledTimes(fetchesAfterFirstLoad);
  });

  it("falls back to the documented catalog when the gateway is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const models = await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });
    expect(models).toEqual(explabsFallbackModels);
  });

  it("falls back on an error status without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429 })),
    );
    const models = await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });
    expect(models).toEqual(explabsFallbackModels);
  });

  it("still lists callable slugs when the facts catalog is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith(explabsCatalogUrl)) {
          return new Response("down", { status: 503 });
        }
        return new Response(callablePayload(["claude-fable-5.1", "gpt-5.6-sol"]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const models = await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });
    expect(models).toEqual(["claude-fable-5.1", "gpt-5.6-sol"]);
  });

  it("paginates the catalog until the announced total is covered", async () => {
    const rowsPage1 = Array.from({ length: 500 }, (_, index) => ({
      model: { slug: `model-${index}`, output_modalities: ["text"] },
      providers: [],
    }));
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("offset=0")) {
        return new Response(
          JSON.stringify({ models: rowsPage1, total: 501, limit: 500, offset: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          models: [{ model: { slug: "model-500", output_modalities: ["text"] }, providers: [] }],
          total: 501,
          limit: 500,
          offset: 500,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const models = await explabsProvider.listModels!({ apiKey: undefined });
    expect(models).toContain("model-0");
    expect(models).toContain("model-500");
    expect(models).toHaveLength(501);
  });
});

interface Captured {
  url: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

describe("Experiential Labs wire behavior over real HTTP", () => {
  let server: Server;
  let origin = "";
  const captured: Captured[] = [];
  let respond: (body: Record<string, unknown>) => { sse: boolean; payload: string };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        captured.push({
          url: req.url ?? "",
          auth: req.headers.authorization,
          body,
        });
        const { sse, payload } = respond(body);
        res.writeHead(200, {
          "content-type": sse ? "text/event-stream" : "application/json",
        });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    captured.length = 0;
    vi.unstubAllGlobals();
  });

  function routeToLocalServer(): void {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
      const url = String(input).replace(explabsBaseUrl, origin);
      return realFetch(url, init);
    });
  }

  it("sends a chat completion with tools and reasoning effort, and parses the reply", async () => {
    respond = () => ({
      sse: false,
      payload: JSON.stringify({
        id: "cmpl-1",
        model: "claude-fable-5.1",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "checking the repo",
              reasoning_content: "I should call a tool",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "fs_read", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 7 },
        },
      }),
    });
    routeToLocalServer();

    const result = await explabsProvider.complete(
      {
        model: "claude-fable-5.1",
        messages: [{ role: "user", content: "look at a.txt" }],
        thinking: { enabled: true, effort: "high" },
        tools: [
          {
            name: "fs.read",
            wireName: "fs_read",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      { apiKey: "xpl_wirekey10000000000000000000000000000000000" },
    );

    const call = captured.find((c) => c.url.includes("/chat/completions"))!;
    expect(call.auth).toBe("Bearer xpl_wirekey10000000000000000000000000000000000");
    expect(call.body.model).toBe("claude-fable-5.1");
    expect(call.body.reasoning_effort).toBe("high");
    expect(Array.isArray(call.body.tools)).toBe(true);
    expect(result.text).toContain("checking the repo");
    expect(result.toolCalls?.[0]?.name).toBe("fs.read");
    expect(result.usage?.cachedPromptTokens).toBe(7);
  });

  it("streams tokens over SSE and returns the assembled result", async () => {
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
      { choices: [{ index: 0, delta: { content: " from " } }] },
      { choices: [{ index: 0, delta: { content: "the gateway" } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
    ];
    respond = () => ({
      sse: true,
      payload:
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
        "data: [DONE]\n\n",
    });
    routeToLocalServer();

    const tokens: string[] = [];
    const result = await explabsProvider.stream!(
      { model: "claude-fable-5.1", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "xpl_wirekey10000000000000000000000000000000000" },
      (token) => tokens.push(token),
    );

    expect(captured[0]!.body.stream).toBe(true);
    expect(tokens.join("")).toBe("Hello from the gateway");
    expect(result.text).toBe("Hello from the gateway");
    expect(result.provider).toBe("explabs");
  });

  it("forwards each documented effort level unchanged, max included", async () => {
    respond = () => ({
      sse: false,
      payload: JSON.stringify({
        model: "claude-fable-5.1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      }),
    });
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      routeToLocalServer();
      await explabsProvider.complete(
        {
          model: "claude-fable-5.1",
          messages: [{ role: "user", content: "hi" }],
          thinking: { enabled: true, effort },
        },
        { apiKey: "xpl_wirekey10000000000000000000000000000000000" },
      );
      expect(captured.at(-1)!.body.reasoning_effort).toBe(effort);
    }
  });

  it("sends reasoning_effort none when thinking is disabled", async () => {
    respond = () => ({
      sse: false,
      payload: JSON.stringify({
        model: "claude-fable-5.1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      }),
    });
    routeToLocalServer();
    await explabsProvider.complete(
      {
        model: "claude-fable-5.1",
        messages: [{ role: "user", content: "hi" }],
        thinking: { enabled: false, effort: "none" },
      },
      { apiKey: "xpl_wirekey10000000000000000000000000000000000" },
    );
    expect(captured[0]!.body.reasoning_effort).toBe("none");
  });
});
