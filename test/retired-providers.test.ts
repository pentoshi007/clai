import { describe, expect, it } from "vitest";

import { providerIds } from "../src/types.js";
import {
  assertProvider,
  defaultModels,
  envVars,
  providerAliases,
} from "../src/llm/provider.js";
import { getProvider, providers } from "../src/llm/router.js";
import { getConfig, providerCategory, updateConfig } from "../src/store/config.js";
import { resolveBuiltInProfile } from "../src/llm/provider-profiles.js";
import { getKnownModels, inferProviderForModel } from "../src/app/commands/catalog.js";

const RETIRED = ["groq", "kimchi"] as const;
const RETIRED_ALIASES = ["groq", "kimchi", "castai"] as const;

describe("retired providers are gone from every registry", () => {
  it("drops them from the provider id list", () => {
    for (const id of RETIRED) {
      expect(providerIds as readonly string[]).not.toContain(id);
    }
  });

  it("refuses to resolve them or their aliases", () => {
    for (const alias of RETIRED_ALIASES) {
      expect(() => assertProvider(alias)).toThrow(/Unsupported provider/);
      expect(providerAliases[alias]).toBeUndefined();
    }
  });

  it("keeps no default model, env var, tier or runtime implementation", () => {
    for (const id of RETIRED) {
      expect((defaultModels as Record<string, string | undefined>)[id]).toBeUndefined();
      expect((envVars as Record<string, string | undefined>)[id]).toBeUndefined();
      expect((providerCategory as Record<string, string | undefined>)[id]).toBeUndefined();
      expect((providers as Record<string, unknown>)[id]).toBeUndefined();
    }
  });

  it("keeps every surviving provider fully wired", () => {
    for (const id of providerIds) {
      expect(defaultModels[id], `${id} default model`).toBeTruthy();
      expect(getProvider(id), `${id} implementation`).toBeDefined();
      expect(resolveBuiltInProfile({ provider: id, model: defaultModels[id] })).toBeDefined();
    }
  });

  it("offers no catalog models under a retired id", () => {
    for (const id of RETIRED) {
      expect(getKnownModels(id)).toEqual([]);
    }
  });

  it("never infers a retired provider from a model name", () => {
    for (const model of ["llama-3.3-70b-versatile", "kimi-k2.6", "openai/gpt-oss-20b"]) {
      const inferred = inferProviderForModel(model);
      if (inferred !== undefined) {
        expect(RETIRED as readonly string[]).not.toContain(inferred);
      }
    }
  });
});

describe("a config pinned to a retired provider still starts", () => {
  it("falls back to the default provider and its model", () => {
    updateConfig({
      defaultProvider: "groq" as never,
      defaultModel: "llama-3.3-70b-versatile",
    });
    const config = getConfig();
    expect(config.defaultProvider).toBe("free");
    expect(config.defaultModel).toBe(defaultModels.free);
    expect(() => assertProvider(config.defaultProvider)).not.toThrow();
  });

  it("forgets a per-provider model saved under a retired id", () => {
    updateConfig({
      providerModels: {
        ...getConfig().providerModels,
        kimchi: "kimi-k2.6",
      } as never,
    });
    expect(
      (getConfig().providerModels as Record<string, string | undefined>).kimchi,
    ).toBeUndefined();
  });

  it("leaves a surviving pinned provider alone", () => {
    updateConfig({ defaultProvider: "nvidia", defaultModel: defaultModels.nvidia });
    expect(getConfig().defaultProvider).toBe("nvidia");
    expect(getConfig().defaultModel).toBe(defaultModels.nvidia);
  });
});
