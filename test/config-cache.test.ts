import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalConfigDir: string | undefined;
let configDir: string;

beforeEach(() => {
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "clai-config-cache-"));
  process.env.CLAI_CONFIG_DIR = configDir;
  vi.resetModules();
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  await rm(configDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("config snapshot cache", () => {
  it("hands out independent copies so callers cannot poison the cache", async () => {
    const { getConfig, updateConfig } = await import("../src/store/config.js");

    updateConfig({ sandboxRoots: ["/tmp/one"] });
    const first = getConfig();
    first.sandboxRoots.push("/tmp/injected");
    first.providerModels.nvidia = "poisoned";
    first.thinking.enabled = true;

    const second = getConfig();
    expect(second.sandboxRoots).toEqual(["/tmp/one"]);
    expect(second.providerModels.nvidia).toBeUndefined();
    expect(second.thinking.enabled).toBe(false);
  });

  it("reflects updateConfig immediately", async () => {
    const { getConfig, updateConfig } = await import("../src/store/config.js");

    expect(getConfig().privateMode).toBe(false);
    updateConfig({ privateMode: true });
    expect(getConfig().privateMode).toBe(true);
  });

  it("picks up external config file edits", async () => {
    const { getConfig, getConfigPath, updateConfig } = await import(
      "../src/store/config.js"
    );

    updateConfig({ historyRetentionLimit: 5 });
    expect(getConfig().historyRetentionLimit).toBe(5);

    const path = getConfigPath();
    const raw = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")),
    ) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({ ...raw, historyRetentionLimit: 9, telemetry: true }),
    );

    expect(getConfig().historyRetentionLimit).toBe(9);
  });
});
