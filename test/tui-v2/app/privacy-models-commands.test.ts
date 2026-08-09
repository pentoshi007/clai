import { beforeEach, describe, expect, it } from "vitest";
import type { AgentPort } from "../../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import { getConfig, updateConfig } from "../../../src/store/config.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../../src/tui-v2/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../../src/tui-v2/app/command-handlers.js";
import { detectCapabilities } from "../../../src/tui-v2/bootstrap/capabilities.js";
import { slashCommands } from "../../../src/repl/slash-commands.js";
import { buildDefaultCommandRegistry } from "../../../src/app/commands/registry.js";

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

describe("/privacy options window", () => {
  beforeEach(() => {
    updateConfig({ disableKeychain: true, privateMode: false });
  });

  it("opens a picker when invoked with no arguments", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "privacy", args: "" });

    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind !== "picker") return;
    expect(overlay.request.title).toMatch(/^Privacy · private mode off$/);
    expect(overlay.request.options.map((option) => option.value)).toEqual([
      "on",
      "clear-history",
      "clear-logs",
      "clear-artifacts",
      "clear-all",
    ]);
  });

  it("offers the inverse toggle when private mode is already on", async () => {
    updateConfig({ privateMode: true });
    const services = buildServices();
    await services.commands.dispatch({ name: "privacy", args: "" });

    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind !== "picker") return;
    expect(overlay.request.title).toContain("private mode on");
    expect(overlay.request.options[0]?.value).toBe("off");
  });

  it("applies the selected toggle and closes the window", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "privacy", args: "" });

    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind !== "picker") return;
    overlay.onSelect("on");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getConfig().privateMode).toBe(true);
    expect(services.overlay.getState().kind).toBe("none");
  });

  it("still supports the explicit argument form", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "privacy", args: "on" });

    expect(getConfig().privateMode).toBe(true);
    expect(services.overlay.getState().kind).toBe("none");
  });
});

describe("/models command registration", () => {
  it("is advertised in the shared slash-command catalogue", () => {
    const entry = slashCommands.find((command) => command.command === "/models");
    expect(entry).toBeDefined();
    expect(entry?.description).toMatch(/all configured providers/i);
  });

  it("resolves as its own command without shadowing /model", () => {
    const registry = buildDefaultCommandRegistry();
    expect(registry.parse("/models")?.name).toBe("models");
    expect(registry.parse("/model")?.name).toBe("model");
    expect(registry.parse("/mod")?.name).toBe("model");
  });

  it("has a handler wired in the TUI", () => {
    const services = buildServices();
    expect(services.commands.resolve("models")).toBe("models");
  });
});
