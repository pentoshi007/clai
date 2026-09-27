import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalConfigDir: string | undefined;
let configDir: string;
let limits: typeof import("../../src/store/context-limits.js");

beforeEach(async () => {
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  configDir = await mkdtemp(join(tmpdir(), "clai-context-limits-"));
  process.env.CLAI_CONFIG_DIR = configDir;
  vi.resetModules();
  limits = await import("../../src/store/context-limits.js");
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  await rm(configDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("custom context limits (durable config-backed overrides)", () => {
  it("survives a module reload", async () => {
    limits.setCustomContextLimit("nvidia", "llama-3.3-70b", 131_072);
    vi.resetModules();
    const reloaded = await import("../../src/store/context-limits.js");
    expect(reloaded.customContextLimit("nvidia", "llama-3.3-70b")).toBe(131_072);
  });

  it("resets one route or clears every route", () => {
    limits.setCustomContextLimit("nvidia", "llama-3.3-70b", 200_000);
    limits.setCustomContextLimit("gemini", "gemini-2.0-flash", 300_000);
    limits.setCustomContextLimit("nvidia", "llama-3.3-70b", undefined);
    expect(limits.customContextLimit("nvidia", "llama-3.3-70b")).toBeUndefined();
    expect(limits.customContextLimit("gemini", "gemini-2.0-flash")).toBe(300_000);

    limits.clearCustomContextLimits();
    expect(limits.customContextLimit("gemini", "gemini-2.0-flash")).toBeUndefined();
  });

  it("scopes limits per provider/model route", () => {
    limits.setCustomContextLimit("nvidia", "llama-3.3-70b", 100_000);
    limits.setCustomContextLimit("gemini", "gemini-2.0-flash", 1_000_000);

    expect(limits.customContextLimit("nvidia", "llama-3.3-70b")).toBe(100_000);
    expect(limits.customContextLimit("gemini", "gemini-2.0-flash")).toBe(1_000_000);
    expect(limits.customContextLimit("nvidia", "gemini-2.0-flash")).toBeUndefined();
  });

  it("rejects limits below the 20k floor", () => {
    limits.setCustomContextLimit("nvidia", "llama-3.3-70b", 5_000);
    expect(limits.customContextLimit("nvidia", "llama-3.3-70b")).toBeUndefined();
  });

  it("picks up external edits to the config file", async () => {
    const { getConfigPath, getConfig } = await import("../../src/store/config.js");
    limits.setCustomContextLimit("gemini", "gemini-2.0-flash", 300_000);

    const { readFileSync, writeFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    raw.contextLimitTokens = { "gemini:gemini-2.0-flash": 256_000 };
    writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2));
    expect(limits.customContextLimit("gemini", "gemini-2.0-flash")).toBe(256_000);
    expect(getConfig().contextLimitTokens?.["gemini:gemini-2.0-flash"]).toBe(256_000);
  });
});
