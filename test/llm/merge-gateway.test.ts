import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mergeGatewayAuthHeaders,
  mergeGatewayBaseUrl,
  mergeGatewayFallbackModels,
  mergeGatewayProvider,
  resetMergeGatewayCatalogCache,
} from "../../src/llm/merge-gateway.js";
import { defaultModels, envVars, normalizeProvider } from "../../src/llm/provider.js";
import { providers } from "../../src/llm/router.js";
import { providerCategory } from "../../src/store/config.js";
import { providerIds } from "../../src/types.js";
import { getKnownModels } from "../../src/app/commands/catalog.js";
import { getProviderInfoText } from "../../src/llm/provider.js";

describe("Merge Gateway provider registration", () => {
  it("is a fully registered built-in provider", () => {
    expect(providerIds).toContain("merge-gateway");
    expect(providers["merge-gateway"]).toBe(mergeGatewayProvider);
    expect(defaultModels["merge-gateway"]).toBe("openai/gpt-5.2");
    expect(envVars["merge-gateway"]).toBe("MERGE_GATEWAY_API_KEY");
    expect(providerCategory["merge-gateway"]).toBe("paid-cloud");
  });

  it("resolves every documented alias", () => {
    for (const alias of ["merge-gateway", "mergegateway", "merge", "mg"]) {
      expect(normalizeProvider(alias)).toBe("merge-gateway");
    }
  });

  it("exposes the full provider surface", () => {
    expect(typeof mergeGatewayProvider.complete).toBe("function");
    expect(typeof mergeGatewayProvider.stream).toBe("function");
    expect(typeof mergeGatewayProvider.listModels).toBe("function");
    expect(typeof mergeGatewayProvider.ping).toBe("function");
    expect(mergeGatewayProvider.reasoningStyle).toBe("openai");
  });

  it("targets the OpenAI-compatible gateway surface", () => {
    expect(mergeGatewayBaseUrl).toBe("https://api-gateway.merge.dev/v1/openai");
  });

  it("sends both auth header shapes the gateway documents", () => {
    const headers = mergeGatewayAuthHeaders("mg_abcd1234");
    expect(headers.authorization).toBe("Bearer mg_abcd1234");
    expect(headers["x-api-key"]).toBe("mg_abcd1234");
  });

  it("validates mg_ key shapes", () => {
    expect(mergeGatewayProvider.validateKey?.("mg_abcdefgh")).toBe(true);
    expect(mergeGatewayProvider.validateKey?.("mg_ABC123_-xyz")).toBe(true);
    expect(mergeGatewayProvider.validateKey?.("sk-abcdefgh")).toBe(false);
    expect(mergeGatewayProvider.validateKey?.("mg_short")).toBe(false);
  });

  it("ships an offline catalog and an info page", () => {
    expect(getKnownModels("merge-gateway").length).toBeGreaterThan(5);
    expect(getKnownModels("merge-gateway")).toContain("openai/gpt-5.2");
    const info = getProviderInfoText("merge-gateway");
    expect(info).toContain("api-gateway.merge.dev");
    expect(info).toContain("MERGE_GATEWAY_API_KEY");
    expect(info).toContain("402");
  });

  it("requires a key for completions, streaming and ping", async () => {
    await expect(mergeGatewayProvider.ping?.({ apiKey: undefined })).rejects.toThrow(
      /API key is required/,
    );
    await expect(
      mergeGatewayProvider.complete({ messages: [] }, { apiKey: undefined }),
    ).rejects.toThrow(/API key is required/);
    await expect(
      mergeGatewayProvider.stream?.({ messages: [] }, { apiKey: undefined }, () => undefined),
    ).rejects.toThrow(/API key is required/);
  });
});

describe("Merge Gateway model discovery", () => {
  afterEach(() => {
    resetMergeGatewayCatalogCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the live catalog and hides non-chat modalities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "openai/gpt-5.2", supported_endpoint_types: ["openai"] },
              { id: "anthropic/claude-sonnet-4-6", supported_endpoint_types: ["chat"] },
              { id: "openai/text-embedding-3-small", supported_endpoint_types: ["openai"] },
              { id: "openai/dall-e-3", supported_endpoint_types: ["openai"] },
              { id: "google/veo-video", supported_endpoint_types: ["openai"] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const models = await mergeGatewayProvider.listModels!({ apiKey: "mg_livekey1" });
    expect(models).toContain("openai/gpt-5.2");
    expect(models).toContain("anthropic/claude-sonnet-4-6");
    expect(models).not.toContain("openai/text-embedding-3-small");
    expect(models).not.toContain("openai/dall-e-3");
    expect(models).not.toContain("google/veo-video");
  });

  it("caches the catalog instead of refetching per call", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.2" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await mergeGatewayProvider.listModels!({ apiKey: "mg_livekey1" });
    const fetchesAfterFirstLoad = fetchMock.mock.calls.length;
    await mergeGatewayProvider.listModels!({ apiKey: "mg_livekey1" });
    await mergeGatewayProvider.listModels!({ apiKey: "mg_livekey1" });
    expect(fetchMock).toHaveBeenCalledTimes(fetchesAfterFirstLoad);
  });

  it("authenticates the catalog request", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.2" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await mergeGatewayProvider.listModels!({ apiKey: "mg_livekey1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${mergeGatewayBaseUrl}/models`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer mg_livekey1");
  });

  it("falls back to the documented catalog when the gateway is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const models = await mergeGatewayProvider.listModels!({ apiKey: "mg_livekey1" });
    expect(models).toEqual(mergeGatewayFallbackModels);
  });

  it("falls back on an error status without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 402 })),
    );
    const models = await mergeGatewayProvider.listModels!({ apiKey: "mg_livekey1" });
    expect(models).toEqual(mergeGatewayFallbackModels);
  });

  it("does not call the gateway without a key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const models = await mergeGatewayProvider.listModels!({ apiKey: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(models).toEqual(mergeGatewayFallbackModels);
  });
});

interface Captured {
  url: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

describe("Merge Gateway wire behavior over real HTTP", () => {
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
    origin = `http://127.0.0.1:${port}/v1/openai`;
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
      const url = String(input).replace(mergeGatewayBaseUrl, origin);
      return realFetch(url, init);
    });
  }

  it("sends a chat completion with tools and reasoning effort, and parses the reply", async () => {
    respond = () => ({
      sse: false,
      payload: JSON.stringify({
        id: "cmpl-1",
        model: "openai/gpt-5.2",
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

    const result = await mergeGatewayProvider.complete(
      {
        model: "openai/gpt-5.2",
        messages: [{ role: "user", content: "read a.txt" }],
        thinking: { enabled: true, effort: "high" },
        tools: [
          {
            name: "fs.read",
            wireName: "fs_read",
            description: "read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { apiKey: "mg_wirekey1" },
    );

    const call = captured.find((c) => c.url.includes("/chat/completions"))!;
    expect(call.auth).toBe("Bearer mg_wirekey1");
    expect(call.body.model).toBe("openai/gpt-5.2");
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
    const result = await mergeGatewayProvider.stream!(
      { model: "openai/gpt-5.2", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "mg_wirekey1" },
      (token) => tokens.push(token),
    );

    expect(captured[0]!.body.stream).toBe(true);
    expect(tokens.join("")).toBe("Hello from the gateway");
    expect(result.text).toBe("Hello from the gateway");
    expect(result.provider).toBe("merge-gateway");
  });

  it("forwards each documented effort level unchanged", async () => {
    respond = () => ({
      sse: false,
      payload: JSON.stringify({
        model: "openai/gpt-5.2",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      }),
    });
    for (const effort of ["low", "medium", "high"] as const) {
      routeToLocalServer();
      await mergeGatewayProvider.complete(
        {
          model: "openai/gpt-5.2",
          messages: [{ role: "user", content: "hi" }],
          thinking: { enabled: true, effort },
        },
        { apiKey: "mg_wirekey1" },
      );
      expect(captured.at(-1)!.body.reasoning_effort).toBe(effort);
    }
  });

  it("turns reasoning down to minimal when thinking is disabled", async () => {
    respond = () => ({
      sse: false,
      payload: JSON.stringify({
        model: "openai/gpt-5.2",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      }),
    });
    routeToLocalServer();
    await mergeGatewayProvider.complete(
      {
        model: "openai/gpt-5.2",
        messages: [{ role: "user", content: "hi" }],
        thinking: { enabled: false, effort: "none" },
      },
      { apiKey: "mg_wirekey1" },
    );
    expect(captured[0]!.body.reasoning_effort).toBe("minimal");
  });
});
