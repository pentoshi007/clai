import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeGatewayProvider,
  resetMergeGatewayCatalogCache,
} from "../src/llm/merge-gateway.js";
import {
  displayReasoningEfforts,
  modelSupportsThinking,
  modelCatalogFacts,
  resetReasoningKnowledge,
} from "../src/llm/capabilities.js";

// Shapes captured from api-gateway.merge.dev on 2026-08-30. The OpenAI-compatible
// route publishes bare ids only; the native /v1/models route is the one that
// carries per-model reasoning metadata.
const OPENAI_ROUTE_MODELS = {
  data: [
    { id: "zai/glm-5.3-flash", object: "model", owned_by: "zai" },
    { id: "qwen/qwen3.8-max", object: "model", owned_by: "qwen" },
    { id: "ai21/jamba-1-5-mini", object: "model", owned_by: "ai21" },
    { id: "gpt-5.2", object: "model", owned_by: "openai" },
    { id: "deepseek/deepseek-v4-flash-latest", object: "model", owned_by: "deepseek" },
    { id: "morph/morph-v3-fast", object: "model", owned_by: "morph" },
  ],
};

function vendor(input: {
  reasoning?: Record<string, unknown> | null;
  supports?: boolean;
  input?: string[];
  context?: number;
  output?: number;
  status?: string;
}) {
  return {
    availability_status: input.status ?? "available",
    context_window: input.context ?? 200_000,
    max_output_tokens: input.output ?? 32_000,
    capabilities: {
      input: input.input ?? ["text"],
      supports_reasoning: input.supports ?? input.reasoning !== undefined,
      reasoning: input.reasoning ?? null,
      supports_tool_calling: true,
    },
  };
}

const GLM_REASONING = {
  configurable: true,
  disable_supported: false,
  default_enabled: true,
  controls: ["reasoning_effort", "thinking"],
  effort_values: ["low", "high", "max"],
  output_style: "reasoning_content",
};

const NATIVE_MODELS = {
  object: "list",
  has_more: false,
  next_cursor: null,
  data: [
    {
      model: "zai/glm-5.3-flash",
      provider: "zai",
      aliases: [],
      availability_status: "available",
      vendors: {
        zai: vendor({
          reasoning: GLM_REASONING,
          input: ["text", "image", "document"],
          context: 1_000_000,
          output: 131_072,
        }),
        baseten: vendor({
          reasoning: GLM_REASONING,
          input: ["text", "image", "document"],
          context: 1_048_000,
          output: 262_000,
        }),
      },
    },
    {
      // Efforts are unioned across routes; images are only claimed when every
      // routable vendor accepts them.
      model: "qwen/qwen3.8-max",
      provider: "qwen",
      aliases: [],
      vendors: {
        alibaba: vendor({
          reasoning: {
            configurable: true,
            disable_supported: true,
            default_enabled: true,
            controls: ["thinking"],
            effort_values: [],
          },
          input: ["text", "image"],
        }),
        togetherai: vendor({
          reasoning: {
            configurable: true,
            disable_supported: true,
            default_enabled: true,
            controls: ["reasoning_effort"],
            effort_values: ["none", "low", "medium", "xhigh"],
          },
          input: ["text"],
        }),
      },
    },
    {
      model: "ai21/jamba-1-5-mini",
      provider: "ai21",
      aliases: [],
      vendors: { bedrock: vendor({ supports: false }) },
    },
    {
      // The native catalog namespaces OpenAI models; the callable id is bare.
      model: "openai/gpt-5.2",
      provider: "openai",
      aliases: [],
      vendors: {
        openai: vendor({
          reasoning: {
            configurable: true,
            disable_supported: true,
            default_enabled: true,
            controls: ["reasoning_effort"],
            effort_values: ["none", "low", "medium", "high"],
            output_style: "hidden",
          },
        }),
      },
    },
    {
      // Floating aliases resolve to the same upstream, so they share its facts.
      model: "deepseek/deepseek-v4-flash",
      provider: "deepseek",
      aliases: [{ model: "deepseek/deepseek-v4-flash-latest", type: "snapshot" }],
      vendors: {
        deepseek: vendor({
          reasoning: {
            configurable: true,
            disable_supported: true,
            default_enabled: true,
            controls: ["reasoning_effort"],
            effort_values: ["low", "high"],
          },
        }),
      },
    },
    {
      // Only an unavailable vendor: its capabilities are still used rather than
      // dropping reasoning support entirely.
      model: "morph/morph-v3-fast",
      provider: "morph",
      aliases: [],
      vendors: {
        morph: vendor({
          reasoning: {
            configurable: true,
            disable_supported: true,
            default_enabled: false,
            controls: ["reasoning_effort"],
            effort_values: ["low", "medium"],
          },
          status: "unavailable",
        }),
      },
    },
  ],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installCatalogFetch(nativeStatus = 200) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: unknown) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/v1/openai/models")) return json(OPENAI_ROUTE_MODELS);
    if (href.includes("/v1/models")) {
      return nativeStatus === 200
        ? json(NATIVE_MODELS)
        : new Response("nope", { status: nativeStatus });
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

describe("Merge Gateway model catalog", () => {
  beforeEach(() => {
    resetMergeGatewayCatalogCache();
    resetReasoningKnowledge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetMergeGatewayCatalogCache();
    resetReasoningKnowledge();
  });

  it("lists the callable ids from the OpenAI-compatible route", async () => {
    installCatalogFetch();
    const models = await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });
    expect(models).toEqual([
      "ai21/jamba-1-5-mini",
      "deepseek/deepseek-v4-flash-latest",
      "gpt-5.2",
      "morph/morph-v3-fast",
      "qwen/qwen3.8-max",
      "zai/glm-5.3-flash",
    ]);
  });

  it("publishes the exact effort ladder each model advertises", async () => {
    installCatalogFetch();
    await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    // GLM accepts low/high/max — not the endpoint's generic low/medium/high.
    expect(displayReasoningEfforts("merge-gateway", "zai/glm-5.3-flash")).toEqual([
      "low",
      "high",
      "max",
    ]);
    // Unioned across routes and ordered cheapest to most expensive.
    expect(displayReasoningEfforts("merge-gateway", "qwen/qwen3.8-max")).toEqual([
      "none",
      "low",
      "medium",
      "xhigh",
    ]);
  });

  it("marks reasoning mandatory only when no route can disable it", async () => {
    installCatalogFetch();
    await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    expect(
      modelCatalogFacts("merge-gateway", "zai/glm-5.3-flash")?.reasoning?.mandatory,
    ).toBe(true);
    expect(
      modelCatalogFacts("merge-gateway", "qwen/qwen3.8-max")?.reasoning?.mandatory,
    ).toBe(false);
  });

  it("stops offering reasoning for models the catalog says cannot reason", async () => {
    installCatalogFetch();
    await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    expect(modelSupportsThinking("merge-gateway", "ai21/jamba-1-5-mini")).toBe(false);
    expect(modelSupportsThinking("merge-gateway", "zai/glm-5.3-flash")).toBe(true);
  });

  it("matches namespaced native metadata to the bare callable id", async () => {
    installCatalogFetch();
    await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    expect(displayReasoningEfforts("merge-gateway", "gpt-5.2")).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
  });

  it("shares a model's facts with its floating aliases", async () => {
    installCatalogFetch();
    await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    expect(
      displayReasoningEfforts("merge-gateway", "deepseek/deepseek-v4-flash-latest"),
    ).toEqual(["low", "high"]);
  });

  it("keeps capabilities from a vendor that is temporarily unavailable", async () => {
    installCatalogFetch();
    await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    expect(displayReasoningEfforts("merge-gateway", "morph/morph-v3-fast")).toEqual([
      "low",
      "medium",
    ]);
  });

  it("takes the smallest limit any route imposes", async () => {
    installCatalogFetch();
    await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    const facts = modelCatalogFacts("merge-gateway", "zai/glm-5.3-flash");
    expect(facts?.contextTokens).toBe(1_000_000);
    expect(facts?.maxOutputTokens).toBe(131_072);
  });

  it("claims vision only when every routable vendor accepts images", async () => {
    installCatalogFetch();
    await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    expect(modelCatalogFacts("merge-gateway", "zai/glm-5.3-flash")?.vision).toBe(true);
    expect(modelCatalogFacts("merge-gateway", "qwen/qwen3.8-max")?.vision).toBe(false);
  });

  it("still lists models when the metadata catalog is unavailable", async () => {
    const { calls } = installCatalogFetch(500);
    const models = await mergeGatewayProvider.listModels!({ apiKey: "mg_synthetic" });

    expect(models).toContain("zai/glm-5.3-flash");
    expect(calls.some((href) => href.includes("/v1/models?limit="))).toBe(true);
    expect(modelCatalogFacts("merge-gateway", "zai/glm-5.3-flash")?.reasoning).toBe(
      undefined,
    );
  });
});
