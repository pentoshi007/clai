import { afterEach, describe, expect, it, vi } from "vitest";

import {
  kiroModelCatalog,
  kiroProvider,
  resetKiroModelCacheForTesting,
} from "../../src/llm/kiro.js";
import {
  encodeKiroFrame,
  installKiroFetch,
  isKiroCatalogRequest,
  isKiroCreateResponseRequest,
  kiroCatalogResponse,
  kiroSseResponse,
  kiroStreamResponse,
  requestBody,
} from "../helpers/kiro-fixtures.js";

const KEY = "kiro-protocol-test-key";
const RESPONSE = kiroSseResponse([
  { type: "response.output_text.delta", delta: "ok" },
  { type: "response.completed", response: { status: "completed" } },
]);
const LEGACY_RESPONSE = kiroStreamResponse([
  encodeKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "ok" }),
]);

const claudeSchema = {
  type: "object",
  properties: {
    thinking: {
      type: "object",
      properties: { type: { type: "string", enum: ["adaptive"] } },
    },
    output_config: {
      type: "object",
      properties: {
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
        },
      },
    },
    max_tokens: { type: "integer", minimum: 1, maximum: 64_000 },
  },
};

const gptSchema = {
  type: "object",
  properties: {
    reasoning: {
      type: "object",
      properties: {
        effort: {
          type: "string",
          enum: ["none", "minimal", "low", "medium", "high"],
        },
      },
    },
  },
};

function catalogModels() {
  return [
    {
      modelId: "claude-opus-5",
      tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
      supportedInputTypes: ["TEXT", "IMAGE"],
      promptCaching: {
        supportsPromptCaching: true,
        maximumCacheCheckpointsPerRequest: 4,
        minimumTokensPerCacheCheckpoint: 1_024,
      },
      additionalModelRequestFieldsSchema: claudeSchema,
    },
    {
      modelId: "gpt-6",
      tokenLimits: { maxInputTokens: 400_000, maxOutputTokens: 32_000 },
      supportedInputTypes: ["TEXT"],
      additionalModelRequestFieldsSchema: gptSchema,
    },
  ];
}

function generationCalls(
  calls: readonly [unknown, RequestInit | undefined][],
): [unknown, RequestInit | undefined][] {
  return calls.filter(([input, init]) => !isKiroCatalogRequest(input, init));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetKiroModelCacheForTesting();
});

describe("Kiro catalog generations and reasoning wire fields", () => {
  it("uses modern management discovery and CreateResponse routing with schema metadata", async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    installKiroFetch(async (input, init) => {
      calls.push([input, init]);
      if (isKiroCatalogRequest(input, init)) {
        return kiroCatalogResponse(catalogModels());
      }
      return RESPONSE.clone();
    });

    const models = await kiroProvider.listModels!({ apiKey: KEY });
    expect(models).toContain("claude-opus-5-thinking");
    expect(models).toContain("gpt-6-thinking");

    await kiroProvider.complete(
      {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "solve" }],
        maxTokens: 80_000,
        thinking: { enabled: true, effort: "max" },
      },
      { apiKey: KEY },
    );
    await kiroProvider.complete(
      {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "brief" }],
        thinking: { enabled: false, effort: "none" },
      },
      { apiKey: KEY },
    );
    await kiroProvider.complete(
      {
        model: "gpt-6",
        messages: [{ role: "user", content: "disabled" }],
        thinking: { enabled: false, effort: "none" },
      },
      { apiKey: KEY },
    );
    await kiroProvider.complete(
      {
        model: "gpt-6",
        messages: [{ role: "user", content: "deep" }],
        thinking: { enabled: true, effort: "xhigh" },
      },
      { apiKey: KEY },
    );
    await kiroProvider.complete(
      {
        model: "claude-opus-5-thinking",
        messages: [{ role: "user", content: "explicitly disabled" }],
        thinking: { enabled: false, effort: "high" },
      },
      { apiKey: KEY },
    );

    const catalogCall = calls.find(([input, init]) =>
      isKiroCatalogRequest(input, init),
    );
    expect(String(catalogCall?.[0])).toBe("https://management.us-east-1.kiro.dev/");
    expect(catalogCall?.[1]?.method).toBe("POST");
    const catalogHeaders = new Headers(catalogCall?.[1]?.headers);
    expect(catalogHeaders.get("content-type")).toBe("application/x-amz-json-1.0");
    expect(catalogHeaders.get("x-amz-target")).toBe(
      "AmazonCodeWhispererService.ListAvailableModels",
    );
    expect(requestBody(catalogCall?.[1])).toEqual({ origin: "KIRO_CLI" });
    expect(catalogHeaders.get("user-agent")).toMatch(
      /^KiroCLI\/3\.5\.0 KAS\/0\.66\.119 /,
    );
    expect(catalogHeaders.get("x-amzn-kiro-origin")).toBe("KIRO_CLI");

    const generations = generationCalls(calls);
    expect(generations).toHaveLength(5);
    for (const [input, init] of generations) {
      expect(String(input)).toBe("https://runtime.us-east-1.kiro.dev/v1/responses");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-amz-target")).toBeNull();
      expect(headers.get("x-amzn-kiro-origin")).toBe("KIRO_CLI");
      expect(headers.get("user-agent")).toMatch(/^KiroCLI\/3\.5\.0 KAS\/0\.66\.119 /);
    }

    const bodies = generations.map(([, init]) => requestBody(init));
    expect(bodies[0]?.model).toBe("claude-opus-5");
    expect(bodies[0]?.stream).toBe(true);
    expect(bodies[0]?.origin).toBe("KIRO_CLI");
    expect(bodies[0]?.input).toEqual([{ role: "user", content: "solve" }]);
    expect(bodies[0]?.reasoning).toEqual({
      type: "adaptive",
      effort: "max",
      summary: "summarized",
    });
    expect(bodies[1]?.reasoning).toEqual({
      type: "adaptive",
      effort: "low",
      summary: "summarized",
    });
    expect(bodies[2]?.reasoning).toEqual({ effort: "none" });
    expect(bodies[3]?.reasoning).toEqual({ effort: "high" });
    expect(bodies[4]?.reasoning).toEqual({
      type: "adaptive",
      effort: "low",
      summary: "summarized",
    });
    expect(kiroModelCatalog()[0]?.promptCaching).toEqual({
      supportsPromptCaching: true,
      maximumCacheCheckpointsPerRequest: 4,
      minimumTokensPerCacheCheckpoint: 1_024,
    });
  });

  it("falls back to the legacy endpoint when /v1/responses is unavailable", async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    installKiroFetch(async (input, init) => {
      calls.push([input, init]);
      const url = String(input);
      if (url.startsWith("https://management.")) {
        return new Response("not found", { status: 404 });
      }
      if (url.includes("ListAvailableModels")) {
        return kiroCatalogResponse([{ modelId: "claude-sonnet-4.5" }]);
      }
      if (isKiroCreateResponseRequest(input)) {
        return new Response("not found", { status: 404 });
      }
      return LEGACY_RESPONSE.clone();
    });

    const result = await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "legacy" }],
      },
      { apiKey: KEY },
    );

    expect(result.text).toBe("ok");
    expect(result.api).toBe("generate-assistant-response");
    expect(String(calls[0]?.[0])).toBe("https://management.us-east-1.kiro.dev/");
    expect(String(calls[1]?.[0])).toContain(
      "https://q.us-east-1.amazonaws.com/ListAvailableModels?",
    );
    expect(calls[1]?.[1]?.method).toBe("GET");
    expect(String(calls[2]?.[0])).toBe(
      "https://runtime.us-east-1.kiro.dev/v1/responses",
    );
    expect(String(calls[3]?.[0])).toBe(
      "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    );
    expect(new Headers(calls[3]?.[1]?.headers).get("x-amz-target")).toBeNull();
  });

  it("remembers a missing CreateResponse operation instead of re-probing", async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    installKiroFetch(async (input, init) => {
      calls.push([input, init]);
      if (isKiroCatalogRequest(input, init)) return kiroCatalogResponse([]);
      if (isKiroCreateResponseRequest(input)) {
        return new Response("not found", { status: 404 });
      }
      return LEGACY_RESPONSE.clone();
    });

    const request = {
      model: "claude-sonnet-4.5",
      messages: [{ role: "user" as const, content: "cached" }],
    };
    await kiroProvider.complete(request, { apiKey: KEY });
    await kiroProvider.complete(request, { apiKey: KEY });

    expect(
      calls.filter(([input]) => isKiroCreateResponseRequest(input)),
    ).toHaveLength(1);
  });

  it("caches a successful empty modern catalog and its runtime generation", async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    installKiroFetch(async (input, init) => {
      calls.push([input, init]);
      if (isKiroCatalogRequest(input, init)) return kiroCatalogResponse([]);
      return RESPONSE.clone();
    });

    expect(await kiroProvider.listModels!({ apiKey: KEY })).toEqual([]);
    expect(await kiroProvider.listModels!({ apiKey: KEY })).toEqual([]);
    await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "cached" }],
      },
      { apiKey: KEY },
    );

    expect(
      calls.filter(([input, init]) => isKiroCatalogRequest(input, init)),
    ).toHaveLength(1);
    const generationCall = calls.find(([input, init]) =>
      !isKiroCatalogRequest(input, init),
    );
    expect(String(generationCall?.[0])).toBe(
      "https://runtime.us-east-1.kiro.dev/v1/responses",
    );
  });
});
