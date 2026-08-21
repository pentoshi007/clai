import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, updateConfig } from "../../../src/store/config.js";
import { createCompositionRoot, type AppServices } from "../../../src/ui-core/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../../src/ui-core/commands/command-handlers.js";
import { detectCapabilities } from "../../../src/ui-core/bootstrap/capabilities.js";
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
  const toasts = services.toast.getToasts();
  return (
    toasts.findLast((toast) => toast.key === "update")?.message ??
    toasts.at(-1)?.message
  );
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

  it("keeps one steady progress chip from download through install", async () => {
    let report: ((progress: unknown) => void) | undefined;
    vi.mocked(installUpdate).mockImplementation(
      async (
        _version: string,
        _log?: (line: string) => void,
        _stdio?: "inherit" | "pipe",
        onProgress?: (progress: never) => void,
      ) => {
        report = onProgress as (progress: unknown) => void;
        return {
          ok: true,
          message: "installed",
          method: "binary",
          needsRestart: true,
        };
      },
    );
    const services = buildServices({
      status: {
        state: "update-available",
        currentVersion: "3.13.2",
        latestVersion: "3.14.0",
        updateAvailable: true,
      },
    });

    await services.commands.dispatch({ name: "update", args: "" });
    expect(report).toBeDefined();

    const chip = () =>
      services.toast.getToasts().find((toast) => toast.key === "update");
    const before = chip();
    expect(before).toBeDefined();
    const index = services.toast
      .getToasts()
      .findIndex((toast) => toast.key === "update");

    for (const receivedBytes of [1_000_000, 40_000_000, 78_000_000]) {
      report?.({ phase: "downloading", receivedBytes, totalBytes: 78_000_000 });
    }
    report?.({ phase: "verifying" });
    report?.({ phase: "installing", detail: "clai-bun-darwin-arm64" });

    const after = chip();
    expect(after?.id).toBe(before?.id);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.message).toContain("installing");
    expect(
      services.toast.getToasts().findIndex((toast) => toast.key === "update"),
    ).toBe(index);
    expect(
      services.toast.getToasts().filter((toast) => toast.key === "update"),
    ).toHaveLength(1);
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