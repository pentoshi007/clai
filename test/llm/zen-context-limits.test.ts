import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCatalogFacts } from "../../src/llm/catalog-facts.js";

const CATALOG_URL = "https://models.opencode.ai/api.json";
const LIMITED_MODELS = [
  "deepseek-v4.1-flash-free",
  "mimo-v2.6-flash-free",
  "glm-5.3-flash-free",
  "big-pickle",
  "future-zen-free",
];

beforeEach(async () => {
  vi.resetModules();
  const { clearModelCatalogFacts } = await import("../../src/llm/capabilities.js");
  clearModelCatalogFacts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("source-backed Zen context limits", () => {
  it("reads OpenCode's current catalog route without sending credentials", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({
      opencode: {
        api: "https://opencode.ai/inference/openai/v1",
        models: {
          "deepseek-v4.1-flash-free": {
            id: "deepseek-v4.1-flash-free",
            limit: { context: 200_000, output: 32_000 },
          },
        },
      },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { supplementZenModelLimits } = await import("../../src/llm/free-model-limits.js");
    const [entry] = await supplementZenModelLimits(["deepseek-v4.1-flash-free"]);

    expect(parseCatalogFacts(entry)).toMatchObject({
      contextTokens: 200_000,
      maxOutputTokens: 32_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(CATALOG_URL, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    const options = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
  });

  it.each(LIMITED_MODELS)("uses 250k for a published 200k Zen window: %s", async (id) => {
    const { registerModelCatalogFacts, modelCatalogFacts } = await import("../../src/llm/capabilities.js");
    const { modelContextWindow, resolveContextWindow } = await import("../../src/llm/context-windows.js");
    const { resolveBuiltInProfile } = await import("../../src/llm/provider-profiles.js");
    const { resolveEffectiveContextLimit } = await import("../../src/agent/request-accounting.js");
    for (const model of [id, `free-1/${id}`]) {
      registerModelCatalogFacts("free", { id: model, contextTokens: 200_000, maxOutputTokens: 32_000 });
      expect(modelCatalogFacts("free", model)?.contextTokens).toBe(200_000);
      expect(modelContextWindow(model, "free")).toBe(250_000);
      expect(resolveContextWindow({ provider: "free", model })).toMatchObject({ tokens: 250_000, source: "provider" });
      expect(resolveBuiltInProfile({ provider: "free", model }).limits).toMatchObject({
        contextTokens: 250_000,
        outputTokens: 32_000,
      });
      expect(resolveEffectiveContextLimit({ provider: "free", model })).toMatchObject({ limitTokens: 250_000 });
    }
  });

  it.each([199_999, 204_800, 262_144, 400_000, 1_000_000, 1_048_576])(
    "preserves other published Zen windows, including updates to DeepSeek: %i",
    async (contextTokens) => {
      const { registerModelCatalogFacts } = await import("../../src/llm/capabilities.js");
      const { modelContextWindow } = await import("../../src/llm/context-windows.js");
      const { resolveBuiltInProfile } = await import("../../src/llm/provider-profiles.js");
      const model = "free-1/deepseek-v4.1-flash-free";
      registerModelCatalogFacts("free", { id: model, contextTokens });
      expect(modelContextWindow(model, "free")).toBe(contextTokens);
      expect(resolveBuiltInProfile({ provider: "free", model }).limits.contextTokens).toBe(contextTokens);
    },
  );

  it.each([
    ["free", "free-2/deepseek-v4.1-flash-free"],
    ["openrouter", "deepseek-v4.1-flash-free"],
    ["mimo", "unknown-model"],
  ] as const)("does not apply the 250k policy outside Zen: %s/%s", async (provider, model) => {
    const { registerModelCatalogFacts } = await import("../../src/llm/capabilities.js");
    const { modelContextWindow } = await import("../../src/llm/context-windows.js");
    const { resolveBuiltInProfile } = await import("../../src/llm/provider-profiles.js");
    registerModelCatalogFacts(provider, { id: model, contextTokens: 200_000 });
    expect(modelContextWindow(model, provider)).toBe(200_000);
    expect(resolveBuiltInProfile({ provider, model }).limits.contextTokens).toBe(200_000);
  });

  it("does not infer 1M for Zen from the upstream model family when no source limit is known", async () => {
    const { modelContextWindow, resolveContextWindow } = await import("../../src/llm/context-windows.js");
    for (const model of ["deepseek-v4.1-flash-free", "free-1/mimo-v2.6-flash-free", "free-1/gemini-3-flash"]) {
      expect(modelContextWindow(model, "free")).toBe(200_000);
      expect(resolveContextWindow({ provider: "free", model })).toMatchObject({ tokens: 200_000, source: "default" });
    }
    expect(modelContextWindow("free-2/deepseek-v4.1-flash-free", "free")).toBe(1_000_000);
    expect(modelContextWindow("mimo-v2.6-flash", "mimo")).toBe(1_000_000);
  });

  it("keeps explicit session overrides separate from the automatic Zen policy", async () => {
    const { registerModelCatalogFacts } = await import("../../src/llm/capabilities.js");
    const { resolveContextWindow } = await import("../../src/llm/context-windows.js");
    const model = "free-1/mimo-v2.6-flash-free";
    registerModelCatalogFacts("free", { id: model, contextTokens: 200_000 });
    expect(resolveContextWindow({ provider: "free", model, contextLimitTokens: 300_000 })).toMatchObject({
      tokens: 300_000,
      source: "session-override",
      providerTokens: 250_000,
    });
  });
});

describe("live Zen model discovery", () => {
  it("discovers and refreshes arbitrary catalog IDs even when /models omits them", async () => {
    const start = 1_900_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(start);
    let refreshed = false;
    const fetchMock = vi.fn(async (input: unknown) => {
      const models = refreshed
        ? {
            "added-catalog-only-free": { cost: { input: 0, output: 0 }, limit: { context: 262_144, output: 65_536 } },
            "first-catalog-only-free": { cost: { input: 0, output: 0 }, status: "deprecated" },
            "paid-free": { cost: { input: 1, output: 2 }, limit: { context: 1_000_000 } },
          }
        : {
            "first-catalog-only-free": { cost: { input: 0, output: 0 }, limit: { context: 200_000, output: 32_000 } },
          };
      const payload = String(input) === CATALOG_URL
        ? { opencode: { api: "https://opencode.ai/inference/openai/v1", models } }
        : { data: [] };
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { freeProvider } = await import("../../src/llm/free.js");
    const { modelContextWindow, modelMaxOutputTokens } = await import("../../src/llm/context-windows.js");

    const initial = await freeProvider.listModels!({});
    expect(initial.filter((id) => id.startsWith("free-1/"))).toEqual(["free-1/first-catalog-only-free"]);
    expect(modelContextWindow("free-1/first-catalog-only-free", "free")).toBe(250_000);
    expect(modelMaxOutputTokens("free", "free-1/first-catalog-only-free")).toBe(32_000);

    refreshed = true;
    vi.mocked(Date.now).mockReturnValue(start + 30 * 60_000);
    const updated = await freeProvider.listModels!({});
    expect(updated.filter((id) => id.startsWith("free-1/"))).toEqual(["free-1/added-catalog-only-free"]);
    expect(modelContextWindow("free-1/added-catalog-only-free", "free")).toBe(262_144);
    expect(modelMaxOutputTokens("free", "free-1/added-catalog-only-free")).toBe(65_536);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("models.dev"))).toBe(false);
  });
});
