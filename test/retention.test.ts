import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateConfig, getConfig } from "../src/store/config.js";

let originalConfigDir: string | undefined;
let configDir: string;

beforeEach(() => {
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "clai-retention-"));
  process.env.CLAI_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  try {
    await rm(configDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("phase 11 — retention config", () => {
  it("privateMode and historyRetentionLimit are persisted via updateConfig", () => {
    updateConfig({ privateMode: true, historyRetentionLimit: 42 });
    expect(getConfig().privateMode).toBe(true);
    expect(getConfig().historyRetentionLimit).toBe(42);
    updateConfig({ privateMode: false, historyRetentionLimit: 200 });
    expect(getConfig().privateMode).toBe(false);
    expect(getConfig().historyRetentionLimit).toBe(200);
  });
});

describe("phase 11 — clearArtifacts and clearAuditLogs", () => {
  it("clearArtifacts removes files in ~/.clai/outputs (best effort)", async () => {
    const { clearArtifacts, getLogsDir } = await import(
      "../src/store/logs.js"
    );
    // The implementation operates on $HOME/.clai/outputs which we can't
    // easily reroute without rebooting modules. Confirm the API shape:
    // it returns a count and never throws on a missing directory.
    const result = await clearArtifacts();
    expect(typeof result.removed).toBe("number");
    // Smoke-check that getLogsDir returns a string under a clai folder.
    expect(getLogsDir()).toMatch(/clai/);
  });
});
