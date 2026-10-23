import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearModelCatalogFacts, clearModelVisionCapabilities, displayReasoningEfforts,
  modelCatalogFacts, modelSupportsThinking, modelSupportsVision, registerWireRejectionEfforts,
  resetReasoningKnowledge, resolveToolDialect,
} from "../../src/llm/capabilities.js";
import { withModelCatalogFacts } from "../../src/llm/catalog-context.js";
import { modelContextWindow, modelMaxOutputTokens } from "../../src/llm/context-windows.js";
import { hinokiProvider, resetHinokiModelCatalogCache } from "../../src/llm/hinoki.js";
import { hinokiModelCatalog } from "../../src/llm/hinoki-models.js";
import { invalidateModelLists } from "../../src/llm/model-list-cache.js";
import { getDefaultModel, getEnvVar, normalizeProvider } from "../../src/llm/provider.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { getProvider } from "../../src/llm/router.js";
import { getActiveProviderEndpoint, providerUsesEndpoints, resolveProviderCategory } from "../../src/store/config.js";
import { envValue } from "../../src/store/keys.js";
import { AUTH, ENTRY, MODEL, REQUEST, completion, json, transport } from "./hinoki-fixtures.js";

beforeEach(() => {
  resetHinokiModelCatalogCache();
  resetReasoningKnowledge();
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Hinoki registration and metadata", () => {
  it("registers aliases, credentials, endpoints, category and the selected provider", () => {
    for (const alias of ["hinoki", "Hinoki-Security", "HINOKI.SECURITY"]) expect(normalizeProvider(alias)).toBe("hinoki");
    expect(getProvider("hinoki")).toBe(hinokiProvider);
    expect(getDefaultModel("hinoki")).toBe(MODEL);
    expect(getEnvVar("hinoki")).toBe("HINOKI_API_KEY");
    vi.stubEnv("HINOKI_API_KEY", AUTH.apiKey);
    vi.stubEnv("HINOKI_BASE_URL", "https://regional.example/v1");
    expect(envValue("hinoki")).toBe(AUTH.apiKey);
    expect(getActiveProviderEndpoint("hinoki")).toBe("https://regional.example/v1");
    expect(providerUsesEndpoints("hinoki")).toBe(true);
    expect(resolveProviderCategory("hinoki")).toBe("paid-cloud");
    expect(hinokiProvider.validateKey(AUTH.apiKey)).toBe(true);
    for (const invalid of ["", "short", "a credential with spaces"]) expect(hinokiProvider.validateKey(invalid)).toBe(false);
  });

  it("parses the actual catalog without inventing numeric limits or future model capabilities", () => {
    const models = hinokiModelCatalog({ data: [ENTRY, ENTRY, { id: "future-chat" }, { id: "audio", type: "transcription" }, { id: "text-embedding-3" }, null] });
    expect(models.map((model) => model.id)).toEqual(["future-chat", MODEL]);
    expect(models[0]?.facts).toEqual({ id: "future-chat" });
    expect(models[1]?.facts).toMatchObject({ contextTokens: 1_048_576, vision: true, tools: true, reasoning: { supported: true } });
    expect(models[1]?.facts?.maxOutputTokens).toBeUndefined();
    expect(models[1]?.facts?.reasoning?.supportedEfforts).toBeUndefined();
  });

  it("publishes dynamically advertised limits, images, tools and efforts", async () => {
    transport(completion, () => json({ data: [{ ...ENTRY, context_window: 96_000, max_output_tokens: 4096,
      input_modalities: ["text"], capabilities: { function_calling: false },
      reasoning: { mandatory: true, supported_efforts: ["low", "high"], default_effort: "high" },
    }] }));
    await hinokiProvider.listModels!(AUTH);
    expect(modelContextWindow(MODEL, "hinoki")).toBe(96_000);
    expect(modelMaxOutputTokens("hinoki", MODEL)).toBe(4096);
    expect(modelSupportsVision("hinoki", MODEL)).toBe(false);
    expect(resolveToolDialect("hinoki", MODEL, "native")).toBe("none");
    expect(displayReasoningEfforts("hinoki", MODEL)).toEqual(["low", "high"]);
    expect(resolveBuiltInProfile({ provider: "hinoki", model: MODEL })).toMatchObject({
      limits: { contextTokens: 96_000, outputTokens: 4096 },
      reasoning: { generation: "mandatory", disable: "unsupported", acceptedEfforts: ["low", "high"] },
    });
  });

  it("updates models and capabilities on explicit discovery and removes stale effort declarations", async () => {
    let entry: object = { ...ENTRY, supported_reasoning_efforts: ["low", "high"] };
    const { fetchMock } = transport(completion, () => json({ data: [entry] }));
    expect(await hinokiProvider.listModels!(AUTH)).toEqual([MODEL]);
    expect(displayReasoningEfforts("hinoki", MODEL)).toEqual(["low", "high"]);
    entry = { ...ENTRY, context_window: 64_000, reasoning: false, supports_vision: false };
    await hinokiProvider.listModels!(AUTH);
    expect(modelContextWindow(MODEL, "hinoki")).toBe(64_000);
    expect(modelSupportsThinking("hinoki", MODEL)).toBe(false);
    expect(modelSupportsVision("hinoki", MODEL)).toBe(false);
    expect(displayReasoningEfforts("hinoki", MODEL)).toEqual([]);
    entry = { id: "new-chat", context_window: 128_000 };
    expect(await hinokiProvider.listModels!(AUTH)).toEqual(["new-chat"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses verified endpoint efforts when omitted and honors runtime rejections", async () => {
    transport();
    await hinokiProvider.listModels!(AUTH);
    expect(displayReasoningEfforts("hinoki", MODEL)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    registerWireRejectionEfforts("hinoki", MODEL, ["low", "high"]);
    expect(displayReasoningEfforts("hinoki", MODEL)).toEqual(["low", "high"]);
    expect(resolveBuiltInProfile({ provider: "hinoki", model: MODEL }).reasoning.acceptedEfforts).toEqual(["low", "high"]);
  });

  it("isolates concurrent generation metadata by key and endpoint", async () => {
    let count = 0;
    const { generations, fetchMock } = transport(completion, () => json({ data: [{ ...ENTRY, max_output_tokens: ++count === 1 ? 1024 : 2048 }] }));
    await Promise.all([
      hinokiProvider.complete({ ...REQUEST, maxTokens: 50_000 }, AUTH),
      hinokiProvider.complete({ ...REQUEST, maxTokens: 50_000 }, { ...AUTH, baseUrl: "https://regional.example" }),
    ]);
    expect(generations.map(({ body }) => (JSON.parse(body) as { max_tokens: number }).max_tokens).sort()).toEqual([1024, 2048]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(2);
    const scoped = hinokiModelCatalog({ data: [{ ...ENTRY, reasoning: false }] });
    withModelCatalogFacts("hinoki", scoped, () => expect(modelSupportsThinking("hinoki", MODEL)).toBe(false));
  });

  it("coalesces reads, reuses generation metadata, expires it and supports invalidation", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { fetchMock } = transport();
    await Promise.all([hinokiProvider.complete(REQUEST, AUTH), hinokiProvider.complete(REQUEST, AUTH)]);
    await hinokiProvider.complete(REQUEST, AUTH);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(1);
    now += 300_001;
    await hinokiProvider.complete(REQUEST, AUTH);
    invalidateModelLists("hinoki");
    await hinokiProvider.complete(REQUEST, AUTH);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(3);
  });

  it("isolates cached models for different keys and keeps returned lists independent", async () => {
    const { fetchMock } = transport();
    const models = await hinokiProvider.listModels!(AUTH);
    models.push("mutated");
    await hinokiProvider.complete(REQUEST, AUTH);
    await hinokiProvider.complete(REQUEST, { apiKey: "hinoki-second-credential" });
    expect(modelCatalogFacts("hinoki", MODEL)?.id).toBe(MODEL);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(2);
  });

  it("retains stale metadata and backs off after transient failures", async () => {
    let now = 1000;
    let fail = false;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { fetchMock } = transport(completion, () => fail ? json({ error: "unavailable" }, 503) : json({ data: [ENTRY] }));
    await hinokiProvider.complete(REQUEST, AUTH);
    now += 300_001;
    fail = true;
    await hinokiProvider.complete(REQUEST, AUTH);
    await hinokiProvider.complete(REQUEST, AUTH);
    expect(modelContextWindow(MODEL, "hinoki")).toBe(1_048_576);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(2);
  });

  it("uses a retry cooldown without cached metadata but never hides rejected credentials", async () => {
    const first = transport(completion, () => json({ error: "unavailable" }, 503));
    await hinokiProvider.complete(REQUEST, AUTH);
    await hinokiProvider.complete(REQUEST, AUTH);
    expect(first.fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(1);
    for (const status of [401, 403]) {
      const rejected = transport(completion, () => json({ error: "invalid credentials" }, status));
      await expect(hinokiProvider.complete(REQUEST, { apiKey: `rejected-credential-${status}` })).rejects.toMatchObject({ status });
      expect(rejected.generations).toHaveLength(0);
    }
  });

  it("verifies keys through the authenticated catalog and rejects malformed/empty results", async () => {
    const { fetchMock } = transport();
    await hinokiProvider.ping(AUTH);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://inference.hinoki.security/v1/models");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ authorization: `Bearer ${AUTH.apiKey}` });
    for (const response of [() => json({ data: [] }), () => new Response("broken")]) {
      transport(completion, response);
      await expect(hinokiProvider.listModels!({ apiKey: `new-${Math.random()}` })).rejects.toThrow();
    }
  });
});
