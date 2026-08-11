import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, updateConfig } from "../../../src/store/config.js";
import { createCompositionRoot, type AppServices } from "../../../src/tui-v2/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../../src/tui-v2/app/command-handlers.js";
import { detectCapabilities } from "../../../src/tui-v2/bootstrap/capabilities.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import type { UpdatesPort, UpdateStatus } from "../../../src/app/ports/updates-port.js";

vi.mock("../../../src/commands/update.js", () => ({
  installUpdate: vi.fn(),
  getCurrentVersion: () => "3.13.2",
  fetchLatestVersion: vi.fn(),
  updateCheckDisabledReason: () => undefined,
}));

import { installUpdate } from "../../../src/commands/update.js";

function fakePersistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

function buildServices(options: {
  status: UpdateStatus;
  requestExit?: () => void;
}): AppServices {
  const updates: UpdatesPort = { check: async () => options.status };
  const services = createCompositionRoot({
    persistence: fakePersistence(),
    updates,
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
    requestExit: options.requestExit ?? (() => {}),
  });
  attachCommandHandlers(services);
  return services;
}

function lastNotice(services: AppServices): string | undefined {
  return services.toast.getToasts().at(-1)?.message;
}

beforeEach(() => {
  updateConfig({ disableKeychain: true });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("/update in the running TUI", () => {
  it("reports when already up to date", async () => {
    const services = buildServices({
      status: {
        state: "current",
        currentVersion: "3.13.2",
        updateAvailable: false,
      },
    });
    await services.commands.dispatch({ name: "update", args: "" });
    expect(lastNotice(services)).toContain("up to date");
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("installs and schedules an exit when an update is available", async () => {
    vi.mocked(installUpdate).mockResolvedValue({
      ok: true,
      message: "updated via bun",
      method: "bun",
      needsRestart: true,
    });
    const requestExit = vi.fn();
    const services = buildServices({
      requestExit,
      status: {
        state: "update-available",
        currentVersion: "3.13.2",
        latestVersion: "3.14.0",
        updateAvailable: true,
      },
    });
    await services.commands.dispatch({ name: "update", args: "" });
    expect(installUpdate).toHaveBeenCalledWith(
      "3.14.0",
      expect.any(Function),
      "pipe",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(requestExit).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(requestExit).toHaveBeenCalledTimes(1);
  });

  it("warns and does not exit when the install fails", async () => {
    vi.mocked(installUpdate).mockResolvedValue({
      ok: false,
      message: "could not detect the installation method",
      method: "unknown",
      needsRestart: false,
    });
    const requestExit = vi.fn();
    const services = buildServices({
      requestExit,
      status: {
        state: "update-available",
        currentVersion: "3.13.2",
        latestVersion: "3.14.0",
        updateAvailable: true,
      },
    });
    await services.commands.dispatch({ name: "update", args: "" });
    expect(lastNotice(services)).toContain("update not applied");
    vi.runAllTimers();
    expect(requestExit).not.toHaveBeenCalled();
  });
});