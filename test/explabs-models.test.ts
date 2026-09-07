import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  explabsBaseUrl,
  explabsCatalogUrl,
  explabsProvider,
  resetExplabsCatalogCache,
} from "../src/llm/explabs.js";
import {
  displayReasoningEfforts,
  modelSupportsThinking,
  modelCatalogFacts,
  resetReasoningKnowledge,
} from "../src/llm/capabilities.js";

// Shapes captured from api.experientiallabs.ai/api/models on 2026-09-07: each row
// is {model, providers[]} and per-deployment capabilities carry the reasoning
// effort ladder, sampling support and modality truth.
function row(input: {
  slug: string;
  input?: string[];
  output?: string[];
  context?: number;
  maxOutput?: number;
  reasoningParam?: boolean;
  providers?: Array<{
    reasoning?: boolean;
    efforts?: string[];
    defaultEffort?: string;
    effortRequired?: boolean;
    temperature?: boolean;
    topP?: boolean;
  }>;
}) {
  return {
    model: {
      slug: input.slug,
      context_window: input.context ?? 200_000,
      max_output_tokens: input.maxOutput ?? 32_000,
      input_modalities: input.input ?? ["text"],
      output_modalities: input.output ?? ["text"],
      supported_params: { tools: true, reasoning: input.reasoningParam },
    },
    providers: (input.providers ?? []).map((provider) => ({
      provider: "openrouter",
      capabilities: {
        supports_reasoning: provider.reasoning ?? provider.efforts !== undefined,
        supported_reasoning_efforts: provider.efforts,
        reasoning_default_effort: provider.defaultEffort,
        reasoning_effort_required: provider.effortRequired,
        supports_temperature: provider.temperature ?? true,
        supports_top_p: provider.topP ?? true,
      },
    })),
  };
}

const CATALOG_ROWS = [
  row({
    slug: "claude-fable-5.1",
    input: ["text", "image"],
    context: 1_000_000,
    maxOutput: 128_000,
    reasoningParam: true,
    providers: [
      {
        reasoning: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
        temperature: false,
        topP: false,
      },
    ],
  }),
  row({
    slug: "gpt-5.6-sol",
    input: ["text", "pdf", "image"],
    reasoningParam: true,
    providers: [
      {
        reasoning: true,
        efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
      {
        reasoning: true,
        efforts: ["low", "medium", "high"],
      },
    ],
  }),
  row({
    slug: "glm-5.3-flash",
    input: ["text", "image", "video"],
    reasoningParam: true,
    providers: [
      {
        reasoning: true,
        efforts: ["xhigh", "max", "high", "low", "medium"],
        effortRequired: true,
      },
    ],
  }),
  row({
    slug: "aion-rp-llama-3.1-8b",
    reasoningParam: false,
    providers: [{ reasoning: false }],
  }),
  row({
    slug: "chatgpt-image-latest",
    output: ["image"],
    reasoningParam: false,
    providers: [{ reasoning: false }],
  }),
];

const CALLABLE_IDS = CATALOG_ROWS.map((entry) => entry.model.slug);

function installCatalogFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith(explabsCatalogUrl)) {
      return new Response(
        JSON.stringify({
          models: CATALOG_ROWS,
          total: CATALOG_ROWS.length,
          limit: 500,
          offset: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${explabsBaseUrl}/models`) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: CALLABLE_IDS.map((id) => ({ id, object: "model" })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Experiential Labs model catalog", () => {
  beforeEach(() => {
    resetExplabsCatalogCache();
    resetReasoningKnowledge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetExplabsCatalogCache();
    resetReasoningKnowledge();
  });

  it("lists the callable slugs minus non-chat entries", async () => {
    installCatalogFetch();
    const models = await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });
    expect(models).toEqual([
      "aion-rp-llama-3.1-8b",
      "claude-fable-5.1",
      "glm-5.3-flash",
      "gpt-5.6-sol",
    ]);
  });

  it("publishes the exact effort ladder each model advertises", async () => {
    installCatalogFetch();
    await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });

    expect(displayReasoningEfforts("explabs", "claude-fable-5.1")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(displayReasoningEfforts("explabs", "gpt-5.6-sol")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(displayReasoningEfforts("explabs", "glm-5.3-flash")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("marks reasoning mandatory only when every rung requires it", async () => {
    installCatalogFetch();
    await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });

    expect(
      modelCatalogFacts("explabs", "glm-5.3-flash")?.reasoning?.mandatory,
    ).toBe(true);
    expect(
      modelCatalogFacts("explabs", "claude-fable-5.1")?.reasoning?.mandatory,
    ).toBe(false);
  });

  it("stops offering reasoning for models the catalog says cannot reason", async () => {
    installCatalogFetch();
    await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });

    expect(modelSupportsThinking("explabs", "aion-rp-llama-3.1-8b")).toBe(false);
    expect(modelSupportsThinking("explabs", "claude-fable-5.1")).toBe(true);
  });

  it("records context windows and vision from the catalog", async () => {
    installCatalogFetch();
    await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });

    const facts = modelCatalogFacts("explabs", "claude-fable-5.1");
    expect(facts?.contextTokens).toBe(1_000_000);
    expect(facts?.maxOutputTokens).toBe(128_000);
    expect(facts?.vision).toBe(true);
    expect(modelCatalogFacts("explabs", "aion-rp-llama-3.1-8b")?.vision).toBe(false);
  });

  it("pins sampling off when no rung accepts it", async () => {
    installCatalogFetch();
    await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });

    expect(modelCatalogFacts("explabs", "claude-fable-5.1")?.defaultSampling).toEqual({
      temperature: null,
      top_p: null,
    });
    expect(
      modelCatalogFacts("explabs", "gpt-5.6-sol")?.defaultSampling,
    ).toBeUndefined();
  });

  it("carries the default effort from the catalog", async () => {
    installCatalogFetch();
    await explabsProvider.listModels!({
      apiKey: "xpl_0123456789abcdef0123456789abcdef01234567",
    });

    expect(
      modelCatalogFacts("explabs", "claude-fable-5.1")?.reasoning?.defaultEffort,
    ).toBe("high");
    expect(
      modelCatalogFacts("explabs", "claude-fable-5.1")?.reasoning?.defaultEnabled,
    ).toBe(true);
  });
});
