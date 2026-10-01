import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  catalogAdvertisedEfforts,
  modelCatalogFacts,
} from "../src/llm/capabilities.js";
import { modelContextWindow } from "../src/llm/context-windows.js";
import type { CompletionRequest } from "../src/types.js";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  replaceProviderKey: vi.fn(),
}));

vi.mock("../src/llm/omnirush-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/omnirush-auth.js")>();
  return { ...actual, refreshOmnirushToken: h.refresh };
});

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) =>
      provider === "omnirush"
        ? {
            keys: [{ id: "omni-key", value: "omnirush-access-1", createdAt: 0 }],
            activeIndex: 0,
            source: "fallback" as const,
          }
        : { keys: [], activeIndex: 0, source: "missing" as const },
    replaceProviderKey: h.replaceProviderKey,
  };
});

const gatewayCatalog = {
  object: "list",
  data: [
    {
      id: "gpt-6-astra",
      object: "model",
      owned_by: "omnirush",
      display_name: "GPT 6 Astra",
      default: true,
      reasoning_levels: ["low", "high", "xhigh", "max"],
      family: "OpenAI",
      status: "active",
      api: "responses",
      limits: { context: 400000, output: 128000 },
      capabilities: {
        reasoning: true,
        tool_call: true,
        web_search: true,
        image_input: true,
        file_input: true,
      },
    },
    {
      id: "gpt-6-sol",
      object: "model",
      owned_by: "omnirush",
      display_name: "GPT 6 Sol",
      reasoning_levels: ["low", "high", "xhigh", "max"],
      api: "responses",
      limits: { context: 400000, output: 128000 },
      capabilities: { reasoning: true, image_input: true },
    },
  ],
};

function catalogResponse(): Response {
  return new Response(JSON.stringify(gatewayCatalog), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function completedEvents(text: string): Array<Record<string, unknown>> {
  return [
    { type: "response.created", response: { id: "resp_1", model: "gpt-6-astra" } },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-6-astra",
        usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
      },
    },
  ];
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ detail: "device_token_invalid" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function request(): CompletionRequest {
  return {
    provider: "omnirush",
    model: "gpt-6-astra",
    messages: [{ role: "user", content: "hi" }],
  };
}

function requestInit(call: unknown[]): RequestInit {
  return call[1] as RequestInit;
}

function headersOf(call: unknown[]): Record<string, string> {
  return requestInit(call).headers as Record<string, string>;
}

describe("Omnirush provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    const { resetOmnirushModelCache } = await import("../src/llm/omnirush.js");
    resetOmnirushModelCache();
  });

  it("lists the gateway catalog and registers model facts", async () => {
    const fetchMock = vi.fn(async () => catalogResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { omnirushProvider } = await import("../src/llm/omnirush.js");
    const models = await omnirushProvider.listModels!({ apiKey: "omnirush-access-1" });

    expect(models).toEqual(["gpt-6-astra", "gpt-6-sol"]);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://omnirush.ai/omnirush/v1/models");
    expect(headersOf(call)).toMatchObject({
      authorization: "Bearer omnirush-access-1",
      accept: "application/json",
    });
    expect(headersOf(call)["user-agent"]).toMatch(/^omnirush \(/);

    const facts = modelCatalogFacts("omnirush", "gpt-6-astra");
    expect(facts?.contextTokens).toBe(400000);
    expect(facts?.maxOutputTokens).toBe(128000);
    expect(facts?.reasoning?.supported).toBe(true);
    expect(facts?.vision).toBe(true);
    expect(catalogAdvertisedEfforts("omnirush", "gpt-6-astra")).toEqual([
      "low",
      "high",
      "xhigh",
      "max",
    ]);
    expect(modelContextWindow("gpt-6-astra", "omnirush")).toBe(400000);
  });

  it("falls back to the shipped catalog when the gateway is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { omnirushProvider } = await import("../src/llm/omnirush.js");
    const models = await omnirushProvider.listModels!({ apiKey: "omnirush-access-1" });

    expect(models).toContain("gpt-6-astra");
    expect(models).toContain("gpt-6-sol");
    expect(models).toContain("gpt-5.6-sol");
  });

  it("streams through /responses with store:false and the omnirush user agent", async () => {
    const fetchMock = vi.fn(async () => sseResponse(completedEvents("pong")));
    vi.stubGlobal("fetch", fetchMock);

    const { omnirushProvider } = await import("../src/llm/omnirush.js");
    const tokens: string[] = [];
    const result = await omnirushProvider.stream!(
      request(),
      { apiKey: "omnirush-access-1" },
      (token) => tokens.push(token),
    );

    expect(result.text).toBe("pong");
    expect(tokens).toEqual(["pong"]);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://omnirush.ai/omnirush/v1/responses");
    const init = requestInit(call);
    expect(init.method).toBe("POST");
    expect(headersOf(call)).toMatchObject({
      authorization: "Bearer omnirush-access-1",
      accept: "text/event-stream",
    });
    expect(headersOf(call)["user-agent"]).toMatch(/^omnirush \(/);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-6-astra");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.input)).toBe(true);
  });

  it("refreshes the device token and retries once after a 401", async () => {
    h.refresh.mockReset().mockResolvedValue({
      accessToken: "omnirush-access-2",
      refreshToken: "omr_refresh_2",
    });
    h.replaceProviderKey.mockReset().mockResolvedValue(true);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(sseResponse(completedEvents("renewed")));
    vi.stubGlobal("fetch", fetchMock);

    const { omnirushProvider } = await import("../src/llm/omnirush.js");
    const statuses: string[] = [];
    const result = await omnirushProvider.stream!(
      request(),
      { apiKey: "omnirush-access-1", refreshToken: "omr_refresh_1" },
      () => {},
      (status) => statuses.push(status),
    );

    expect(result.text).toBe("renewed");
    expect(statuses).toEqual([
      "i Omnirush authentication rejected — refreshing token",
      "i Omnirush token refreshed — retrying request",
    ]);
    expect(h.refresh).toHaveBeenCalledWith("omr_refresh_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchMock.mock.calls[0]!).authorization).toBe(
      "Bearer omnirush-access-1",
    );
    expect(headersOf(fetchMock.mock.calls[1]!).authorization).toBe(
      "Bearer omnirush-access-2",
    );
    expect(h.replaceProviderKey).toHaveBeenCalledWith(
      "omnirush",
      "omnirush-access-1",
      "omnirush-access-2",
      { refreshToken: "omr_refresh_2" },
    );
  });

  it("completes through the streaming /responses endpoint", async () => {
    const fetchMock = vi.fn(async () => sseResponse(completedEvents("pong")));
    vi.stubGlobal("fetch", fetchMock);

    const { omnirushProvider } = await import("../src/llm/omnirush.js");
    const result = await omnirushProvider.complete!(request(), {
      apiKey: "omnirush-access-1",
    });

    expect(result.text).toBe("pong");
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://omnirush.ai/omnirush/v1/responses");
    const body = JSON.parse(String(requestInit(call).body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  it("ping verifies the credential via the gateway /models", async () => {
    const fetchMock = vi.fn(async () => catalogResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { omnirushProvider } = await import("../src/llm/omnirush.js");
    await expect(
      omnirushProvider.ping({ apiKey: "omnirush-access-1" }),
    ).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://omnirush.ai/omnirush/v1/models",
    );
  });

  it("ping surfaces an auth failure without a key", async () => {
    const { omnirushProvider } = await import("../src/llm/omnirush.js");
    await expect(omnirushProvider.ping({})).rejects.toThrow(/authentication required/i);
  });

  it("validates key shape", async () => {
    const { omnirushProvider } = await import("../src/llm/omnirush.js");
    expect(omnirushProvider.validateKey("omnirush-69a5a559c7bad229539eb4ee95d8a5ea")).toBe(true);
    expect(omnirushProvider.validateKey("short")).toBe(false);
  });
});
