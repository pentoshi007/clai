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
  kiroCatalogResponse,
  kiroStreamResponse,
  requestBody,
} from "../helpers/kiro-fixtures.js";

const KEY = "kiro-protocol-test-key";
const RESPONSE = kiroStreamResponse([
  encodeKiroFrame(
    { ":event-type": "assistantResponseEvent" },
    { content: "ok" },
  ),
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

function generationBodies(
  calls: readonly [unknown, RequestInit | undefined][],
): Record<string, unknown>[] {
  return calls
    .filter(([input, init]) => !isKiroCatalogRequest(input, init))
    .map(([, init]) => requestBody(init));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetKiroModelCacheForTesting();
});

describe("Kiro catalog generations and reasoning wire fields", () => {
  it("uses modern management discovery and runtime routing with schema metadata", async () => {
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

    const generationCalls = calls.filter(([input, init]) =>
      !isKiroCatalogRequest(input, init),
    );
    expect(generationCalls).toHaveLength(5);
    for (const [input, init] of generationCalls) {
      expect(String(input)).toBe("https://runtime.us-east-1.kiro.dev/");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/x-amz-json-1.0");
      expect(headers.get("x-amz-target")).toBe(
        "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      );
    }

    const bodies = generationBodies(calls);
    expect(bodies[0]?.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
      max_tokens: 64_000,
    });
    expect(bodies[1]?.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
    });
    expect(bodies[2]?.additionalModelRequestFields).toEqual({
      reasoning: { effort: "none" },
    });
    expect(bodies[3]?.additionalModelRequestFields).toEqual({
      reasoning: { effort: "high" },
    });
    expect(bodies[4]?.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
    });
    expect(kiroModelCatalog()[0]?.promptCaching).toEqual({
      supportsPromptCaching: true,
      maximumCacheCheckpointsPerRequest: 4,
      minimumTokensPerCacheCheckpoint: 1_024,
    });
  });

  it("falls back from modern management to legacy catalog and generation", async () => {
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
      return RESPONSE.clone();
    });

    const result = await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "legacy" }],
      },
      { apiKey: KEY },
    );

    expect(result.text).toBe("ok");
    expect(String(calls[0]?.[0])).toBe("https://management.us-east-1.kiro.dev/");
    expect(String(calls[1]?.[0])).toContain(
      "https://q.us-east-1.amazonaws.com/ListAvailableModels?",
    );
    expect(calls[1]?.[1]?.method).toBe("GET");
    expect(String(calls[2]?.[0])).toBe(
      "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    );
    expect(new Headers(calls[2]?.[1]?.headers).get("x-amz-target")).toBeNull();
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
      "https://runtime.us-east-1.kiro.dev/",
    );
  });
});
