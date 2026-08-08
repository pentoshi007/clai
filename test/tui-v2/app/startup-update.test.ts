import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfig } from "../../../src/store/config.js";
import { createCompositionRoot, type AppServices } from "../../../src/tui-v2/bootstrap/composition-root.js";
import { detectCapabilities } from "../../../src/tui-v2/bootstrap/capabilities.js";
import { maybeShowUpdateToast } from "../../../src/tui-v2/app/startup-update.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import type { UpdatesPort, UpdateStatus } from "../../../src/app/ports/updates-port.js";

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

function buildServices(status: UpdateStatus): AppServices {
  const updates: UpdatesPort = { check: async () => status };
  return createCompositionRoot({
    persistence: fakePersistence(),
    updates,
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
  });
}

function lastToast(services: AppServices): string | undefined {
  return services.toast.getToasts().at(-1)?.message;
}

beforeEach(() => {
  updateConfig({ disableKeychain: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maybeShowUpdateToast", () => {
  it("shows a toast when an update is available", async () => {
    const services = buildServices({
      state: "update-available",
      currentVersion: "3.13.2",
      latestVersion: "3.14.0",
      updateAvailable: true,
    });
    await maybeShowUpdateToast(services);
    expect(lastToast(services)).toContain("Update available: 3.13.2 → 3.14.0");
    expect(lastToast(services)).toContain("/update");
  });

  it("stays silent when already up to date", async () => {
    const services = buildServices({
      state: "current",
      currentVersion: "3.13.2",
      updateAvailable: false,
    });
    await maybeShowUpdateToast(services);
    expect(lastToast(services)).toBeUndefined();
  });

  it("respects the 4h check interval", async () => {
    const services = buildServices({
      state: "update-available",
      currentVersion: "3.13.2",
      latestVersion: "3.14.0",
      updateAvailable: true,
    });
    updateConfig({ lastUpdateCheck: Date.now() });
    await maybeShowUpdateToast(services);
    expect(lastToast(services)).toBeUndefined();
  });

  it("skips when update checks are disabled via env", async () => {
    vi.stubEnv("CLAI_NO_UPDATE_CHECK", "1");
    const services = buildServices({
      state: "update-available",
      currentVersion: "3.13.2",
      latestVersion: "3.14.0",
      updateAvailable: true,
    });
    await maybeShowUpdateToast(services);
    expect(lastToast(services)).toBeUndefined();
  });

  it("does not show the toast when cancelled before resolution", async () => {
    const services = buildServices({
      state: "update-available",
      currentVersion: "3.13.2",
      latestVersion: "3.14.0",
      updateAvailable: true,
    });
    await maybeShowUpdateToast(services, () => true);
    expect(lastToast(services)).toBeUndefined();
  });
});