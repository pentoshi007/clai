import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  displayReasoningEfforts,
  modelCatalogFacts,
  modelSupportsThinking,
  resetReasoningKnowledge,
} from "../src/llm/capabilities.js";
import {
  vercelGatewayBaseUrl,
  vercelProvider,
  resetVercelGatewayCatalogCache,
  VERCEL_RESPONSES_CONFIG,
} from "../src/llm/vercel.js";
import { buildResponsesBody } from "../src/llm/responses-request.js";

const CATALOG = [
  {
    id: "openai/gpt-5.4-mini",
    type: "language",
    context_window: 400_000,
    max_tokens: 32_000,
    tags: ["reasoning", "tool-use"],
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning_options: [
      { type: "effort", values: ["low", "medium", "high", "max"] },
    ],
  },
  {
    id: "minimax/minimax-h3",
    type: "video",
    modalities: { input: ["text", "image"], output: ["video"] },
  },
];

function installCatalogFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    expect(String(input)).toBe(`${vercelGatewayBaseUrl}/models`);
    return new Response(JSON.stringify({ object: "list", data: CATALOG }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Vercel AI Gateway model catalog", () => {
  beforeEach(() => {
    resetVercelGatewayCatalogCache();
    resetReasoningKnowledge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetVercelGatewayCatalogCache();
    resetReasoningKnowledge();
  });

  it("filters the live catalog and registers model-specific efforts", async () => {
    installCatalogFetch();
    const models = await vercelProvider.listModels!({ apiKey: "gateway-test-key" });

    expect(models).toEqual(["openai/gpt-5.4-mini"]);
    expect(displayReasoningEfforts("vercel", "openai/gpt-5.4-mini")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(modelSupportsThinking("vercel", "openai/gpt-5.4-mini")).toBe(true);

    const facts = modelCatalogFacts("vercel", "openai/gpt-5.4-mini");
    expect(facts?.contextTokens).toBe(400_000);
    expect(facts?.maxOutputTokens).toBe(32_000);
    expect(facts?.modalities).toEqual(["text", "image"]);
    expect(facts?.vision).toBe(true);
  });

  it("deduplicates concurrent catalog fetches", async () => {
    const fetchMock = installCatalogFetch();
    const [first, second] = await Promise.all([
      vercelProvider.listModels!({}),
      vercelProvider.listModels!({}),
    ]);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Vercel AI Gateway Responses body", () => {
  it("enables automatic caching with a bounded stable key", () => {
    const body = JSON.parse(buildResponsesBody(VERCEL_RESPONSES_CONFIG, {
      model: "openai/gpt-5.4-mini",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })) as Record<string, unknown>;

    expect(body.caching).toBe("auto");
    expect(body.cache_ttl).toBe("5m");
    expect(body.store).toBe(false);
    expect(typeof body.prompt_cache_key).toBe("string");
    expect(String(body.prompt_cache_key).length).toBeLessThanOrEqual(64);
    expect(String(body.prompt_cache_key).startsWith("clai-")).toBe(true);
    expect(body.stream).toBe(true);
  });
});
