import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContextLimits } from "../../src/app/controllers/session-context-limits.js";

let originalConfigDir: string | undefined;
let configDir: string;
let limits: typeof SessionContextLimits;

beforeEach(async () => {
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  configDir = await mkdtemp(join(tmpdir(), "clai-context-limits-"));
  process.env.CLAI_CONFIG_DIR = configDir;
  vi.resetModules();
  ({ SessionContextLimits: limits } = await import(
    "../../src/app/controllers/session-context-limits.js"
  ));
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  await rm(configDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("SessionContextLimits (durable config-backed overrides)", () => {
  it("survives a fresh instance", () => {
    const first = new limits();
    first.set("nvidia", "llama-3.3-70b", 131_072);

    const second = new limits();
    expect(second.get("nvidia", "llama-3.3-70b")).toBe(131_072);
  });

  it("clear() removes persisted limits", () => {
    const contextLimits = new limits();
    contextLimits.set("nvidia", "llama-3.3-70b", 200_000);
    expect(contextLimits.get("nvidia", "llama-3.3-70b")).toBe(200_000);

    contextLimits.clear();
    expect(contextLimits.get("nvidia", "llama-3.3-70b")).toBeUndefined();
  });

  it("scopes limits per provider/model route", () => {
    const contextLimits = new limits();
    contextLimits.set("nvidia", "llama-3.3-70b", 100_000);
    contextLimits.set("gemini", "gemini-2.0-flash", 1_000_000);

    expect(contextLimits.get("nvidia", "llama-3.3-70b")).toBe(100_000);
    expect(contextLimits.get("gemini", "gemini-2.0-flash")).toBe(1_000_000);
    expect(contextLimits.get("nvidia", "gemini-2.0-flash")).toBeUndefined();
  });

  it("rejects limits below the 20k floor", () => {
    const contextLimits = new limits();
    contextLimits.set("nvidia", "llama-3.3-70b", 5_000);
    expect(contextLimits.get("nvidia", "llama-3.3-70b")).toBeUndefined();
  });

  it("picks up external edits to the config file", async () => {
    const { getConfigPath, getConfig } = await import("../../src/store/config.js");
    const contextLimits = new limits();
    contextLimits.set("gemini", "gemini-2.0-flash", 300_000);

    const { readFileSync, writeFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    raw.contextLimitTokens = { "gemini:gemini-2.0-flash": 256_000 };
    writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2));
    expect(contextLimits.get("gemini", "gemini-2.0-flash")).toBe(256_000);
    expect(getConfig().contextLimitTokens?.["gemini:gemini-2.0-flash"]).toBe(256_000);
  });
});
