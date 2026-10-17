import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constellationProvider, resetConstellationModelCatalogCache } from "../src/llm/constellation.js";
import { constellationModelCatalog } from "../src/llm/constellation-models.js";
import {
  clearModelCatalogFacts,
  displayReasoningEfforts,
  modelCatalogFacts,
  modelSupportsThinking,
  modelSupportsVision,
  registerWireRejectionEfforts,
  resetReasoningKnowledge,
  resolveToolDialect,
} from "../src/llm/capabilities.js";
import { modelContextWindow, modelMaxOutputTokens } from "../src/llm/context-windows.js";
import { resolveBuiltInProfile } from "../src/llm/provider-profiles.js";
import { envValue } from "../src/store/keys.js";
import { getDefaultModel, getEnvVar, normalizeProvider, redactSecrets } from "../src/llm/provider.js";
import { getProvider } from "../src/llm/router.js";
import { needsEffortPreflight } from "../src/llm/wire/effort-preflight.js";

const MODEL = "openai/gpt-5-4-mini";
const entry = {
  id: MODEL,
  type: "multimodal",
  context_window: 400_000,
  max_tokens: 128_000,
  models_dev_id: "openai/gpt-5.4-mini",
  tags: ["promptCaching", "reasoning", "tool-use", "vision"],
  tool_shapes: { function: { verdict: "works", source: "discovery" } },
};
const auth = { apiKey: "sk-gw-testcredential" };

function catalog(data: readonly unknown[]): Response {
  return Response.json({ object: "list", data });
}

beforeEach(() => {
  resetConstellationModelCatalogCache();
  resetReasoningKnowledge();
  clearModelCatalogFacts();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Constellation provider registration", () => {
  it("registers aliases, documented environment credentials, default and secret redaction", () => {
    for (const alias of ["constellation", "constellationgate", "constellation-gate", "GATE"])
      expect(normalizeProvider(alias)).toBe("constellation");
    expect(getProvider("constellation")).toBe(constellationProvider);
    expect(getDefaultModel("constellation")).toBe(MODEL);
    expect(getEnvVar("constellation")).toBe("GATE_API_KEY");
    vi.stubEnv("GATE_API_KEY", auth.apiKey);
    expect(envValue("constellation")).toBe(auth.apiKey);
    expect(constellationProvider.validateKey(auth.apiKey)).toBe(true);
    for (const key of ["sk-openai-key", "", "sk-gw-", "sk-gw-a b cdefg"])
      expect(constellationProvider.validateKey(key)).toBe(false);
    expect(redactSecrets(auth.apiKey)).not.toContain("testcredential");
  });

  it("validates a key against generation rather than the public catalog", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: "invalid_key", message: "Invalid or revoked API key." } }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(constellationProvider.ping(auth)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gateway.constellationgate.ai/v1/chat/completions");
  });
});

describe("Constellation dynamic model metadata", () => {
  it("parses live catalog fields and filters non-chat entries without guessing capabilities", () => {
    const models = constellationModelCatalog({ data: [entry, entry, { id: "future/chat" }, { id: "audio/stt", type: "transcription" }, null] });
    expect(models.map((m) => m.id)).toEqual(["future/chat", MODEL]);
    expect(models[0]?.facts?.vision).toBeUndefined();
    expect(models[1]?.facts).toMatchObject({ contextTokens: 400_000, maxOutputTokens: 128_000, canonicalModel: "openai/gpt-5.4-mini", tools: true, vision: true, reasoning: { supported: true } });
  });

  it("publishes live context, output, vision, tools and reasoning to shared UI contracts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => catalog([entry, { id: "vendor/chat", tags: [] }, { id: "vendor/claude", tags: ["vision", "tool-use"], tool_shapes: { function: { verdict: "fails" } } }])));
    await constellationProvider.listModels!(auth);
    expect(modelContextWindow(MODEL, "constellation")).toBe(400_000);
    expect(modelMaxOutputTokens("constellation", MODEL)).toBe(128_000);
    expect(modelSupportsVision("constellation", MODEL)).toBe(true);
    expect(modelSupportsThinking("constellation", MODEL)).toBe(true);
    expect(resolveToolDialect("constellation", MODEL, "native")).toBe("openai");
    expect(resolveToolDialect("constellation", "vendor/claude", "native")).toBe("none");
    expect(modelSupportsVision("constellation", "vendor/chat")).toBe(false);
    expect(modelSupportsThinking("constellation", "vendor/chat")).toBe(false);
    expect(modelCatalogFacts("constellation", MODEL)?.canonicalModel).toBe("openai/gpt-5.4-mini");
    const profile = resolveBuiltInProfile({ provider: "constellation", model: MODEL });
    expect(profile.cache.kind).toBe("automatic-prefix");
    expect(profile.limits.contextTokens).toBe(400_000);
    expect(profile.reasoning.control.dialect).toBe("openai-effort");
  });

  it("seeds the documented gateway effort vocabulary, honors catalog-declared efforts, and prefers runtime-learned settings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => catalog([entry, { ...entry, id: "vendor/explicit", supported_reasoning_efforts: ["low", "high"] }])));
    await constellationProvider.listModels!(auth);
    expect(displayReasoningEfforts("constellation", MODEL)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(needsEffortPreflight({ providerId: "constellation", model: MODEL, requested: "high", purpose: "turn" })).toBe(false);
    expect(displayReasoningEfforts("constellation", "vendor/explicit")).toEqual(["low", "high"]);
    registerWireRejectionEfforts("constellation", MODEL, ["low", "medium", "high"]);
    expect(displayReasoningEfforts("constellation", MODEL)).toEqual(["low", "medium", "high"]);
    expect(resolveBuiltInProfile({ provider: "constellation", model: MODEL }).reasoning.acceptedEfforts).toEqual(["low", "medium", "high"]);
  });

  it("coalesces discovery and caches per credential for one minute, then refreshes metadata", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = vi.fn(async () => catalog([entry]));
    vi.stubGlobal("fetch", fetchMock);
    const [first, second] = await Promise.all([constellationProvider.listModels!(auth), constellationProvider.listModels!(auth)]);
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.push("not-a-real-model");
    expect(await constellationProvider.listModels!(auth)).toEqual([MODEL]);
    await constellationProvider.listModels!({ apiKey: "sk-gw-anothercredential" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    fetchMock.mockImplementation(async () => catalog([{ ...entry, tags: [], context_window: 64_000 }]));
    await constellationProvider.listModels!(auth);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(modelContextWindow(MODEL, "constellation")).toBe(64_000);
    expect(modelSupportsThinking("constellation", MODEL)).toBe(false);
    expect(modelSupportsVision("constellation", MODEL)).toBe(false);
  });

  it("retains a stale catalog only for transient errors, not auth failures", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = vi.fn(async () => catalog([entry]));
    vi.stubGlobal("fetch", fetchMock);
    await constellationProvider.listModels!(auth);
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    fetchMock.mockImplementation(async () => new Response("temporarily unavailable", { status: 503 }));
    expect(await constellationProvider.listModels!(auth)).toEqual([MODEL]);
    fetchMock.mockImplementation(async () => Response.json({ error: { message: "invalid key" } }, { status: 401 }));
    await expect(constellationProvider.listModels!(auth)).rejects.toMatchObject({ status: 401 });
    fetchMock.mockImplementation(async () => new Response("broken json", { status: 200 }));
    await expect(constellationProvider.listModels!({ apiKey: "sk-gw-othercredential" })).rejects.toThrow();
  });
});
