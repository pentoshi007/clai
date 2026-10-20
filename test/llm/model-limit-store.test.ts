import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  observedOutputCap,
  reloadRememberedModelLimits,
  rememberModelLimits,
  rememberObservedOutputCap,
  rememberedModelLimits,
} from "../../src/llm/model-limit-store.js";
import { routeOutputTokenLimit } from "../../src/llm/provider-profiles.js";
import {
  registerModelCatalog,
  registerModelCatalogLimits,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import {
  modelContextWindow,
  modelMaxOutputTokens,
  resolveContextWindow,
} from "../../src/llm/context-windows.js";

let dataDir: string;
let originalDataDir: string | undefined;

const storePath = (): string => join(dataDir, "model-context-limits.json");

beforeEach(() => {
  originalDataDir = process.env.CLAI_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "clai-model-limits-"));
  process.env.CLAI_DATA_DIR = dataDir;
  resetReasoningKnowledge();
});

afterEach(() => {
  resetReasoningKnowledge();
  if (originalDataDir === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("remembered model limits", () => {
  it("persists official limits and ignores unusable values", () => {
    rememberModelLimits("openrouter", [
      { model: "Vendor/Model-A", contextTokens: 262_144, maxOutputTokens: 32_768 },
      { model: "vendor/model-b", contextTokens: 0 },
      { model: "vendor/model-c" },
    ]);

    expect(rememberedModelLimits("openrouter", "vendor/model-a")).toEqual({
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
    });
    expect(rememberedModelLimits("openrouter", "vendor/model-b")).toBeUndefined();
    expect(rememberedModelLimits("anthropic", "vendor/model-a")).toBeUndefined();
    expect(JSON.parse(readFileSync(storePath(), "utf8"))).toEqual({
      version: 1,
      entries: {
        "openrouter:vendor/model-a": { contextTokens: 262_144, maxOutputTokens: 32_768 },
      },
    });
  });

  it("serves persisted limits before the live catalog has been fetched", () => {
    writeFileSync(
      storePath(),
      JSON.stringify({
        version: 1,
        entries: { "gemini:gemini-9-pro": { contextTokens: 2_097_152, maxOutputTokens: 65_536 } },
      }),
    );
    reloadRememberedModelLimits();

    expect(modelContextWindow("gemini-9-pro", "gemini")).toBe(2_097_152);
    expect(modelMaxOutputTokens("gemini", "gemini-9-pro")).toBe(65_536);
    expect(resolveContextWindow({ provider: "gemini", model: "gemini-9-pro" })).toMatchObject({
      source: "provider",
      tokens: 2_097_152,
    });
  });

  it("survives a restart after catalogs are ingested through the shared registration paths", () => {
    registerModelCatalog("openrouter", [
      { id: "vendor/wide", facts: { id: "vendor/wide", contextTokens: 1_048_576 } },
    ]);
    registerModelCatalogLimits("kiro", [{ id: "claude-x", contextTokens: 500_000 }]);
    reloadRememberedModelLimits();

    expect(rememberedModelLimits("openrouter", "vendor/wide")?.contextTokens).toBe(1_048_576);
    expect(rememberedModelLimits("kiro", "claude-x")?.contextTokens).toBe(500_000);
  });

  it("ignores a store written with an unknown version", () => {
    writeFileSync(
      storePath(),
      JSON.stringify({ version: 99, entries: { "gemini:m": { contextTokens: 10 } } }),
    );
    reloadRememberedModelLimits();

    expect(rememberedModelLimits("gemini", "m")).toBeUndefined();
  });

  it("resolves route output limits as observed, then catalog, then remembered, then documented", () => {
    expect(routeOutputTokenLimit("river", "deepseek-ai/DeepSeek-V4.1-Flash")).toBe(384_000);
    const model = "vendor/reasoner-9";
    expect(routeOutputTokenLimit("tokenrouter", model)).toBeUndefined();
    rememberModelLimits("tokenrouter", [{ model, contextTokens: 1_048_576, maxOutputTokens: 200_000 }]);
    expect(routeOutputTokenLimit("tokenrouter", model)).toBe(200_000);
    registerModelCatalog("tokenrouter", [{ id: model, facts: { id: model, maxOutputTokens: 300_000 } }]);
    expect(routeOutputTokenLimit("tokenrouter", model)).toBe(300_000);
    rememberObservedOutputCap("tokenrouter", model, 96_000);
    expect(routeOutputTokenLimit("tokenrouter", model)).toBe(96_000);
    expect(routeOutputTokenLimit("tokenrouter", "unlisted-model-xyz")).toBeUndefined();
  });

  it("persists observed output caps across restarts without disturbing context entries", () => {
    rememberModelLimits("openrouter", [{ model: "vendor/a", contextTokens: 262_144 }]);
    rememberObservedOutputCap("free", "free-1/Model-X", 32_000);
    reloadRememberedModelLimits();

    expect(observedOutputCap("free", "free-1/model-x")).toBe(32_000);
    expect(modelMaxOutputTokens("free", "free-1/model-x")).toBe(32_000);
    expect(rememberedModelLimits("openrouter", "vendor/a")?.contextTokens).toBe(262_144);
    expect(JSON.parse(readFileSync(storePath(), "utf8"))).toMatchObject({
      version: 1,
      outputCaps: { "free:free-1/model-x": 32_000 },
    });
  });

  it("falls back to the 200k default when nothing is known", () => {
    expect(resolveContextWindow({ provider: "openrouter", model: "vendor/unknown-9" })).toMatchObject({
      source: "default",
      tokens: 200_000,
    });
  });
});
