import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort } from "../../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import { updateConfig } from "../../../src/store/config.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../../src/tui-v2/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../../src/tui-v2/app/command-handlers.js";
import { detectCapabilities } from "../../../src/tui-v2/bootstrap/capabilities.js";
import * as history from "../../../src/store/history.js";

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

function buildServices(): AppServices {
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
  });
  attachCommandHandlers(services);
  return services;
}

const SESSIONS = [
  {
    id: "sess-old-1",
    name: "First chat",
    itemCount: 4,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:05:00.000Z",
    cwd: "/tmp/project",
  },
  {
    id: "sess-old-2",
    name: "Second chat",
    itemCount: 7,
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T10:05:00.000Z",
    cwd: "/tmp/project",
  },
];

describe("/history row delete", () => {
  beforeEach(() => {
    updateConfig({ disableKeychain: true });
    vi.restoreAllMocks();
    vi.spyOn(history, "listSessionSummaries").mockResolvedValue(
      SESSIONS as never,
    );
  });

  it("exposes ctrl+x as the row action", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "history", args: "" });

    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind !== "picker") return;
    expect(overlay.request.rowAction).toEqual({
      chord: "ctrl+x",
      hint: "^x:delete",
    });
  });

  it("purges the session and drops the row in place", async () => {
    const purge = vi
      .spyOn(history, "purgeSession")
      .mockResolvedValue({
        deleted: true,
        detail: "deleted sess-old-2 + artifacts",
        removedWorkspace: true,
        removedPlan: true,
      });
    const services = buildServices();
    await services.commands.dispatch({ name: "history", args: "" });

    const before = services.overlay.getState();
    expect(before.kind).toBe("picker");
    if (before.kind !== "picker") return;
    expect(before.request.options.map((o) => o.value)).toContain("sess-old-2");

    services.overlay.actOnPickerRow("sess-old-2");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(purge).toHaveBeenCalledWith("sess-old-2");
    const after = services.overlay.getState();
    expect(after.kind).toBe("picker");
    if (after.kind !== "picker") return;
    expect(after.request.options.map((o) => o.value)).not.toContain("sess-old-2");
    expect(after.request.options.map((o) => o.value)).toContain("sess-old-1");
  });

  it("refuses to delete the session currently open", async () => {
    const purge = vi.spyOn(history, "purgeSession");
    const services = buildServices();
    await services.commands.dispatch({ name: "history", args: "" });

    services.overlay.actOnPickerRow("__current__");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(purge).not.toHaveBeenCalled();
    const state = services.overlay.getState();
    expect(state.kind).toBe("picker");
    if (state.kind !== "picker") return;
    expect(state.request.options.map((o) => o.value)).toContain("__current__");
    expect(services.toast.getToasts().map((t) => t.message)).toContain(
      "cannot delete the session you are in",
    );
  });

  it("keeps the row when the purge fails", async () => {
    vi.spyOn(history, "purgeSession").mockResolvedValue({
      deleted: false,
      detail: "session not found",
      removedWorkspace: false,
      removedPlan: false,
    });
    const services = buildServices();
    await services.commands.dispatch({ name: "history", args: "" });

    services.overlay.actOnPickerRow("sess-old-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      services.toast.getToasts().some((t) => /could not delete/.test(t.message)),
    ).toBe(true);
  });
});
