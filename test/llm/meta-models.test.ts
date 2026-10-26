import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaProvider } from "../../src/llm/meta.js";
import { clearModelCatalogFacts, displayReasoningEfforts, effectiveThinkingEffort, modelCatalogFacts, modelSupportsThinking, registerWireRejectionEfforts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { rememberMainEffort } from "../../src/llm/main-effort-discovery.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { modelContextWindow, resolveContextWindow } from "../../src/llm/context-windows.js";
import { invalidateModelLists, MODEL_LIST_TTL_MS } from "../../src/llm/model-list-cache.js";
import { reasoningOptionValues } from "../../src/ui-core/commands/pickers/search-reasoning.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";

const auth = { apiKey: "fixture-meta-key" };
const allEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"];

function catalog(entries: readonly object[]) {
  return new Response(JSON.stringify({ object: "list", data: entries }), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  resetReasoningKnowledge();
  invalidateModelLists("meta");
});
afterEach(() => {
  resetReasoningKnowledge();
  clearModelCatalogFacts();
  invalidateModelLists("meta");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Meta model capabilities", () => {
  it.each(["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2", "muse-spark-1.1"])("uses documented context without pretending the ID-only %s catalog published it", async (model) => {
    vi.stubGlobal("fetch", vi.fn(async () => catalog([{ id: model, object: "model", created: 1, owned_by: "meta" }])));
    expect(await metaProvider.listModels!(auth)).toEqual([model]);
    expect(modelCatalogFacts("meta", model)?.contextTokens).toBeUndefined();
    expect(resolveContextWindow({ provider: "meta", model })).toMatchObject({ tokens: 1_048_576, source: "model-table" });
    expect(reasoningOptionValues("meta", model)).toEqual(model.endsWith("1.0") || model.endsWith("1.3") ? allEfforts : allEfforts.slice(0, -1));
  });

  it("uses documented max support before catalog loading", () => {
    expect(reasoningOptionValues("meta", "muse-wonder-1.0")).toEqual(allEfforts);
    expect(reasoningOptionValues("meta", "muse-spark-1.3")).toEqual(allEfforts);
    expect(reasoningOptionValues("meta", "muse-spark-1.3-contributor")).toEqual(allEfforts.slice(0, -1));
  });

  it.each([262_144, 2_097_152])("prefers live context %s and model-specific efforts to documented defaults", async (context) => {
    vi.stubGlobal("fetch", vi.fn(async () => catalog([{
      id: "muse-wonder-1.0", context_length: context, max_output_tokens: 32_768,
      reasoning: { supported_efforts: ["low", "max"], mandatory: true },
    }])));
    await metaProvider.listModels!(auth);
    expect(resolveContextWindow({ provider: "meta", model: "muse-wonder-1.0" })).toMatchObject({ tokens: context, source: "provider" });
    expect(displayReasoningEfforts("meta", "muse-wonder-1.0")).toEqual(["low", "max"]);
    expect(reasoningOptionValues("meta", "muse-wonder-1.0")).toEqual(["low", "max"]);
    expect(resolveBuiltInProfile({ provider: "meta", model: "muse-wonder-1.0" }).limits.outputTokens).toBe(32_768);
    expect(modelContextWindow("muse-wonder-1.0", "openai")).toBe(1_048_576);
  });

  it("does not advertise unverified efforts for unknown or non-reasoning models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => catalog([{ id: "future-model" }, { id: "muse-image-1.0", reasoning: false }])));
    await metaProvider.listModels!(auth);
    expect(reasoningOptionValues("meta", "future-model")).toEqual([]);
    expect(modelSupportsThinking("meta", "muse-image-1.0")).toBe(false);
    expect(displayReasoningEfforts("meta", "muse-image-1.0") ?? []).toEqual([]);
    expect(reasoningOptionValues("meta", "muse-image-1.0")).toEqual(["off"]);
    expect(resolveBuiltInProfile({ provider: "meta", model: "muse-image-1.0" }).reasoning.control.status).toBe("unsupported");
  });

  it("refreshes published efforts, then falls back when the next catalog omits them", async () => {
    let entries: object[] = [{ id: "muse-wonder-1.0", context_length: 262_144, supported_reasoning_efforts: ["low", "high"] }];
    const fetchMock = vi.fn(async () => catalog(entries));
    vi.stubGlobal("fetch", fetchMock);
    await metaProvider.listModels!(auth);
    expect(displayReasoningEfforts("meta", "muse-wonder-1.0")).toEqual(["low", "high"]);
    entries = [{ id: "muse-wonder-1.0", context_length: 1_048_576, supported_reasoning_efforts: ["minimal", "max"] }];
    invalidateModelLists("meta");
    await metaProvider.listModels!(auth);
    expect(displayReasoningEfforts("meta", "muse-wonder-1.0")).toEqual(["minimal", "max"]);
    entries = [{ id: "muse-wonder-1.0" }];
    invalidateModelLists("meta");
    await metaProvider.listModels!(auth);
    expect(displayReasoningEfforts("meta", "muse-wonder-1.0")).toEqual(allEfforts);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps catalogs separated by credential and refreshes after the TTL", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(async () => catalog([{ id: "muse-wonder-1.0" }]));
    vi.stubGlobal("fetch", fetchMock);
    await metaProvider.listModels!(auth);
    await metaProvider.listModels!(auth);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await metaProvider.listModels!({ apiKey: "another-fixture-key" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += MODEL_LIST_TTL_MS;
    await metaProvider.listModels!(auth);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("replays each credential's capability metadata on a cache hit", async () => {
    let entries = [{ id: "muse-wonder-1.0", context_length: 262_144, supported_reasoning_efforts: ["low", "max"] }];
    const fetchMock = vi.fn(async () => catalog(entries));
    vi.stubGlobal("fetch", fetchMock);
    await metaProvider.listModels!(auth);
    entries = [{ id: "muse-wonder-1.0", context_length: 2_097_152, supported_reasoning_efforts: ["minimal", "high"] }];
    await metaProvider.listModels!({ apiKey: "another-fixture-key" });
    expect(displayReasoningEfforts("meta", "muse-wonder-1.0")).toEqual(["minimal", "high"]);
    await metaProvider.listModels!(auth);
    expect(displayReasoningEfforts("meta", "muse-wonder-1.0")).toEqual(["low", "max"]);
    expect(resolveContextWindow({ provider: "meta", model: "muse-wonder-1.0" }).tokens).toBe(262_144);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes an already-created auxiliary reasoning snapshot", async () => {
    await withSessionAffinity("meta-catalog:auxiliary", async () => {
      expect(reasoningOptionValues("meta", "muse-wonder-1.0")).toEqual(allEfforts);
      vi.stubGlobal("fetch", vi.fn(async () => catalog([{
        id: "muse-wonder-1.0", supported_reasoning_efforts: ["low", "max"],
      }])));
      await metaProvider.listModels!(auth);
      expect(reasoningOptionValues("meta", "muse-wonder-1.0")).toEqual(["low", "max"]);
    });
  });

  it.each([false, { supported: false }])("honors an explicit negative declaration %j over prior support", async (reasoning) => {
    registerWireRejectionEfforts("meta", "muse-wonder-1.0", ["max"]);
    vi.stubGlobal("fetch", vi.fn(async () => catalog([{ id: "muse-wonder-1.0", reasoning }])));
    await metaProvider.listModels!(auth);
    expect(modelSupportsThinking("meta", "muse-wonder-1.0")).toBe(false);
    expect(displayReasoningEfforts("meta", "muse-wonder-1.0")).toEqual([]);
    expect(reasoningOptionValues("meta", "muse-wonder-1.0")).toEqual(["off"]);
    expect(resolveBuiltInProfile({ provider: "meta", model: "muse-wonder-1.0" }).reasoning.control.status).toBe("unsupported");
  });

  it("does not invent controls when the published effort list is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => catalog([{
      id: "muse-wonder-1.0", reasoning: { supported_efforts: [], mandatory: true },
    }])));
    await metaProvider.listModels!(auth);
    expect(displayReasoningEfforts("meta", "muse-wonder-1.0")).toEqual([]);
    expect(reasoningOptionValues("meta", "muse-wonder-1.0")).toEqual([]);
    expect(resolveBuiltInProfile({ provider: "meta", model: "muse-wonder-1.0" }).reasoning.control.status).toBe("unsupported");
  });

  it("does not silently apply stale learned downgrades to newly published max support", async () => {
    rememberMainEffort("meta", "muse-wonder-1.0", "max", "high");
    registerWireRejectionEfforts("meta", "muse-wonder-1.0", ["high"]);
    vi.stubGlobal("fetch", vi.fn(async () => catalog([{
      id: "muse-wonder-1.0", supported_reasoning_efforts: ["low", "max"],
    }])));
    await metaProvider.listModels!(auth);
    expect(effectiveThinkingEffort("meta", "muse-wonder-1.0", { enabled: true, effort: "max" })).toBe("max");
    expect(reasoningOptionValues("meta", "muse-wonder-1.0")).toEqual(["low", "max"]);
    expect(resolveBuiltInProfile({ provider: "meta", model: "muse-wonder-1.0" }).reasoning.acceptedEfforts).toEqual(["low", "max"]);
  });
});
