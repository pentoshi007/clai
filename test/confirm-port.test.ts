import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall } from "../src/types.js";
import type { ConfirmPort } from "../src/agent/confirm-port.js";

describe("confirm-port", () => {
  let configDir: string;

  beforeEach(() => {
    vi.resetModules();
    configDir = mkdtempSync(join(tmpdir(), 'clai-confirm-test-'));
    vi.stubEnv('CLAI_CONFIG_DIR', configDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function loadConfirmPort() {
    return await import("../src/agent/confirm-port.js");
  }

  async function loadConfigStore() {
    return await import('../src/store/config.js');
  }

  async function loadSessionPolicy() {
    return await import("../src/agent/session-policy.js");
  }

  it("prompts for confirmation under default permissions", async () => {
    const { updateConfig } = await loadConfigStore();
    updateConfig({ permissions: "default" });

    const { confirmToolExecution } = await loadConfirmPort();
    const { createSessionPolicy } = await loadSessionPolicy();

    const session = createSessionPolicy();
    const call: ToolCall = { name: "shell.exec", args: { command: "rm -rf /" } };

    const mockConfirmPort: ConfirmPort = {
      confirmTool: vi.fn().mockResolvedValue(true),
      confirmPentest: vi.fn().mockResolvedValue(true),
    };

    const ok = await confirmToolExecution(call, false, session, mockConfirmPort);
    expect(ok).toBe(true);
    expect(mockConfirmPort.confirmTool).toHaveBeenCalledWith(call);
  });

  it("bypasses confirmation under allow-all permissions", async () => {
    const { updateConfig } = await loadConfigStore();
    updateConfig({ permissions: "allow-all" });

    const { confirmToolExecution } = await loadConfirmPort();
    const { createSessionPolicy } = await loadSessionPolicy();

    const session = createSessionPolicy();
    const call: ToolCall = { name: "shell.exec", args: { command: "rm -rf /" } };

    const mockConfirmPortDisabled: ConfirmPort = {
      confirmTool: vi.fn(),
      confirmPentest: vi.fn(),
    };

    const ok = await confirmToolExecution(call, false, session, mockConfirmPortDisabled);
    expect(ok).toBe(true);
    expect(mockConfirmPortDisabled.confirmTool).not.toHaveBeenCalled();
  });
});
