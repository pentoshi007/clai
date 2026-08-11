import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort } from "../../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import type { UpdatesPort } from "../../../src/app/ports/updates-port.js";
import { updateConfig } from "../../../src/store/config.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../../src/ui-core/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../../src/ui-core/commands/command-handlers.js";
import { detectCapabilities } from "../../../src/ui-core/bootstrap/capabilities.js";
import * as update from "../../../src/commands/update.js";

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

function fakeAgent(): AgentPort {
  return { async runTurn() { return ""; } };
}

function buildServices(updates: UpdatesPort, requestExit = () => {}): AppServices {
  const services = createCompositionRoot({
    agent: fakeAgent(),
    persistence: fakePersistence(),
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
    updates,
    requestExit,
  });
  attachCommandHandlers(services);
  return services;
}

function messages(services: AppServices): string[] {
  return services.toast.getToasts().map((toast) => toast.message);
}

describe("/update toasts", () => {
  beforeEach(() => {
    updateConfig({ disableKeychain: true });
    vi.restoreAllMocks();
  });

  it("reports up to date without downloading anything", async () => {
    const install = vi.spyOn(update, "installUpdate");
    const services = buildServices({
      async check() {
        return { state: "current", currentVersion: "3.15.0" };
      },
    } as UpdatesPort);

    await services.commands.dispatch({ name: "update", args: "" });

    expect(install).not.toHaveBeenCalled();
    expect(messages(services)).toContain("up to date · v3.15.0");
  });

  it("shows a sticky toast while checking", async () => {
    let release: (() => void) | undefined;
    const services = buildServices({
      async check() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { state: "current", currentVersion: "3.15.0" };
      },
    } as UpdatesPort);

    const pending = services.commands.dispatch({ name: "update", args: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const checking = services.toast
      .getToasts()
      .find((toast) => toast.message === "checking for updates…");
    expect(checking).toBeDefined();
    expect(checking?.sticky).toBe(true);

    release?.();
    await pending;
  });

  it("announces the new version and renders download progress", async () => {
    vi.spyOn(update, "installUpdate").mockImplementation(
      async (_version, _log, _stdio, onProgress) => {
        onProgress?.({ phase: "downloading", receivedBytes: 0, totalBytes: 1000 });
        onProgress?.({
          phase: "downloading",
          receivedBytes: 1000,
          totalBytes: 1000,
        });
        onProgress?.({ phase: "verifying" });
        onProgress?.({ phase: "installing" });
        return {
          ok: true,
          message: "installed",
          method: "binary",
          needsRestart: true,
        };
      },
    );
    const seen: string[] = [];
    const services = buildServices({
      async check() {
        return {
          state: "update-available",
          currentVersion: "3.15.0",
          latestVersion: "3.16.0",
        };
      },
    } as UpdatesPort);
    services.toast.subscribe(() => {
      for (const message of messages(services)) {
        if (!seen.includes(message)) seen.push(message);
      }
    });

    await services.commands.dispatch({ name: "update", args: "" });

    expect(seen.some((m) => m.includes("update available · v3.15.0 → v3.16.0"))).toBe(
      true,
    );
    expect(seen.some((m) => /downloading .*100% · 1000 B\/1000 B/.test(m))).toBe(
      true,
    );
    expect(seen.some((m) => m.includes("verifying checksum"))).toBe(true);
    expect(seen.some((m) => m.includes("installing"))).toBe(true);
    expect(messages(services)).toContain("updated to v3.16.0 · restarting…");
  });

  it("keeps the update toast sticky for the whole download", async () => {
    let sticky = true;
    vi.spyOn(update, "installUpdate").mockImplementation(
      async (_version, _log, _stdio, onProgress) => {
        onProgress?.({ phase: "downloading", receivedBytes: 5, totalBytes: 10 });
        return {
          ok: true,
          message: "installed",
          method: "binary",
          needsRestart: true,
        };
      },
    );
    const services = buildServices({
      async check() {
        return {
          state: "update-available",
          currentVersion: "3.15.0",
          latestVersion: "3.16.0",
        };
      },
    } as UpdatesPort);
    services.toast.subscribe(() => {
      for (const toast of services.toast.getToasts()) {
        if (/downloading/.test(toast.message) && !toast.sticky) sticky = false;
      }
    });

    await services.commands.dispatch({ name: "update", args: "" });
    expect(sticky).toBe(true);
  });

  it("surfaces a failed install without exiting", async () => {
    vi.spyOn(update, "installUpdate").mockResolvedValue({
      ok: false,
      message: "no write access",
      method: "binary",
      needsRestart: false,
    });
    let exited = false;
    const services = buildServices(
      {
        async check() {
          return {
            state: "update-available",
            currentVersion: "3.15.0",
            latestVersion: "3.16.0",
          };
        },
      } as UpdatesPort,
      () => {
        exited = true;
      },
    );

    await services.commands.dispatch({ name: "update", args: "" });

    expect(exited).toBe(false);
    expect(
      messages(services).some((m) => m.includes("update not applied")),
    ).toBe(true);
  });
});
