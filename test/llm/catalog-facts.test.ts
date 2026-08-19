import { describe, expect, it } from "vitest";

import {
  catalogEffortList,
  catalogEntriesFromPayload,
  parseCatalogFacts,
  type CatalogFacts,
} from "../../src/llm/catalog-facts.js";
import liveCatalogs from "./fixtures/live-model-catalogs.json" with { type: "json" };

interface RecordedCatalog {
  readonly envelope: string;
  readonly entries: readonly Record<string, unknown>[];
}

const recorded = liveCatalogs as unknown as Record<string, RecordedCatalog>;

function factsFor(provider: string, id: string): CatalogFacts {
  const catalog = recorded[provider];
  if (!catalog) throw new Error(`no recorded catalog for ${provider}`);
  const entry = catalog.entries.find(
    (candidate) => candidate.id === id || candidate.name === id,
  );
  if (!entry) throw new Error(`no recorded entry ${provider}/${id}`);
  const facts = parseCatalogFacts(entry);
  if (!facts) throw new Error(`unparsed entry ${provider}/${id}`);
  return facts;
}

describe("parseCatalogFacts against recorded live payloads", () => {
  it("reads OpenRouter's reasoning object for kimi-k3", () => {
    const facts = factsFor("openrouter", "moonshotai/kimi-k3");
    expect(facts.reasoning?.supported).toBe(true);
    expect(facts.reasoning?.mandatory).toBe(false);
    expect(facts.reasoning?.defaultEnabled).toBe(true);
    expect(catalogEffortList(facts.reasoning?.supportedEfforts)).toEqual([
      "max",
      "high",
      "low",
    ]);
    expect(facts.reasoning?.defaultEffort).toBe("max");
    expect(facts.acceptedParameters).toContain("reasoning_effort");
    expect(facts.contextTokens).toBe(1_048_576);
    expect(facts.defaultSampling).toEqual({
      temperature: null,
      top_p: 0.95,
      top_k: null,
      frequency_penalty: null,
      presence_penalty: null,
      repetition_penalty: null,
    });
    expect(facts.modalities).toEqual(["text", "image", "video"]);
  });

  it("resolves kimi-k2.6 as toggle-only because no effort knob is published", () => {
    const facts = factsFor("openrouter", "moonshotai/kimi-k2.6");
    expect(facts.reasoning?.supported).toBe(true);
    expect(facts.reasoning?.defaultEnabled).toBe(true);
    expect(facts.reasoning?.supportedEfforts).toBeUndefined();
    expect(facts.acceptedParameters).not.toContain("reasoning_effort");
  });

  it("reads mandatory reasoning for qwen3.8-max", () => {
    const facts = factsFor("openrouter", "qwen/qwen3.8-max");
    expect(facts.reasoning?.mandatory).toBe(true);
    expect(facts.maxOutputTokens).toBe(131_072);
  });

  it("reads deepseek-v4-pro's recommended sampling and output ceiling", () => {
    const facts = factsFor("openrouter", "deepseek/deepseek-v4-pro");
    expect(facts.defaultSampling).toEqual({ temperature: 1, top_p: 1 });
    expect(facts.maxOutputTokens).toBe(384_000);
    expect(catalogEffortList(facts.reasoning?.supportedEfforts)).toEqual([
      "xhigh",
      "high",
    ]);
  });

  it("reads supports_max_tokens where published", () => {
    const facts = factsFor("openrouter", "nvidia/nemotron-3-ultra-550b-a55b");
    expect(facts.reasoning?.supportsMaxTokens).toBe(true);
  });

  it("prefers the served context length over the nominal one", () => {
    const facts = parseCatalogFacts({
      id: "deepseek/deepseek-v4-flash-latest",
      context_length: 1_310_720,
      top_provider: { context_length: 262_144, max_completion_tokens: null },
    });
    expect(facts?.contextTokens).toBe(262_144);
    expect(facts?.nominalContextTokens).toBe(1_310_720);
    expect(facts?.maxOutputTokens).toBeUndefined();
  });

  it("treats a null supported_efforts as any accepted value", () => {
    const facts = parseCatalogFacts({
      id: "some/model",
      reasoning: { mandatory: false, supported_efforts: null },
    });
    expect(facts?.reasoning?.supportedEfforts).toBe("any");
    expect(catalogEffortList(facts?.reasoning?.supportedEfforts)).toBeUndefined();
  });

  it("unions reasoning evidence across containers instead of returning on the first", () => {
    const facts = parseCatalogFacts({
      id: "vendor/model",
      supported_features: ["vision"],
      supported_parameters: ["reasoning_effort"],
    });
    expect(facts?.reasoning?.supported).toBe(true);
  });

  it("keeps absent reasoning evidence undefined rather than false", () => {
    const facts = parseCatalogFacts({ id: "bare/model", object: "model" });
    expect(facts?.reasoning).toBeUndefined();
  });

  it("does not read a null reasoning field as unsupported", () => {
    const facts = parseCatalogFacts({ id: "vendor/model", reasoning: null });
    expect(facts?.reasoning?.supported).toBeUndefined();
  });
});

describe("parseCatalogFacts tolerates every recorded gateway shape", () => {
  it("parses an id out of every recorded entry", () => {
    for (const [provider, catalog] of Object.entries(recorded)) {
      for (const entry of catalog.entries) {
        const facts = parseCatalogFacts(entry);
        expect(facts, `${provider} entry without an id`).toBeDefined();
        expect(facts!.id.length).toBeGreaterThan(0);
      }
    }
  });

  it("reads Modal's advertised effort list from reasoning_options", () => {
    const facts = factsFor("modal", "moonshotai/Kimi-K3");
    expect(catalogEffortList(facts.reasoning?.supportedEfforts)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(facts.reasoning?.supported).toBe(true);
    expect(facts.contextTokens).toBe(1_048_576);
  });

  it("reads Bynara's flat reasoning and vision booleans plus context_window", () => {
    const facts = factsFor("bynara", "agnes-2.0-flash");
    expect(facts.reasoning?.supported).toBe(true);
    expect(facts.vision).toBe(true);
    expect(facts.contextTokens).toBe(512_000);
  });

  it("reads Fireworks' flat vision flag and context length", () => {
    const facts = factsFor("fireworks", "accounts/fireworks/models/kimi-k2p6");
    expect(facts.vision).toBe(true);
    expect(facts.contextTokens).toBe(262_144);
    expect(facts.reasoning).toBeUndefined();
  });

  it("reads Hetzner's max_model_len as the context window", () => {
    const facts = factsFor("hetzner", "Qwen/Qwen3.6-35B-A3B-FP8");
    expect(facts.contextTokens).toBe(262_144);
  });

  it("leaves bare TokenRouter entries without invented facts", () => {
    const facts = factsFor("tokenrouter", "moonshotai/kimi-k3");
    expect(facts.reasoning).toBeUndefined();
    expect(facts.contextTokens).toBeUndefined();
    expect(facts.acceptedParameters).toBeUndefined();
  });

  it("strips the models/ prefix from Gemini names", () => {
    const entries = recorded.gemini?.entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(parseCatalogFacts(entry)?.id.startsWith("models/")).toBe(false);
    }
  });
});

describe("catalogEntriesFromPayload", () => {
  it("accepts bare arrays, {data:[]} and {models:[]}", () => {
    expect(catalogEntriesFromPayload(["a", "b"])).toHaveLength(2);
    expect(catalogEntriesFromPayload({ data: [{ id: "a" }] })).toHaveLength(1);
    expect(catalogEntriesFromPayload({ models: [{ name: "a" }] })).toHaveLength(1);
    expect(catalogEntriesFromPayload({ nope: 1 })).toHaveLength(0);
    expect(catalogEntriesFromPayload(undefined)).toHaveLength(0);
  });

  it("parses bare string entries", () => {
    expect(parseCatalogFacts("kimi-k3")).toEqual({ id: "kimi-k3" });
  });
});
