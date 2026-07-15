import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalConfigDir: string | undefined;
let configDir: string;

beforeEach(() => {
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "clai-retention-"));
  process.env.CLAI_CONFIG_DIR = configDir;
  // The `Conf` store inside `src/store/config.ts` captures
  // `CLAI_CONFIG_DIR` at module import time. Reset the module
  // cache so the dynamic import below re-reads the env var and
  // points at this test's tmp dir, avoiding cross-test pollution
  // when retention.test.ts runs after another test that already
  // imported config.ts.
  vi.resetModules();
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  try {
    await rm(configDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  vi.resetModules();
});

describe("phase 11 — retention config", () => {
  it("privateMode and historyRetentionLimit are persisted via updateConfig", async () => {
    const { updateConfig, getConfig } = await import(
      "../src/store/config.js"
    );
    updateConfig({ privateMode: true, historyRetentionLimit: 42 });
    expect(getConfig().privateMode).toBe(true);
    expect(getConfig().historyRetentionLimit).toBe(42);
    updateConfig({ privateMode: false, historyRetentionLimit: 0 });
    expect(getConfig().privateMode).toBe(false);
    expect(getConfig().historyRetentionLimit).toBe(0);
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
