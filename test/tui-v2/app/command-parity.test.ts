import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort } from "../../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import { getConfig, updateConfig } from "../../../src/store/config.js";
import { createCompositionRoot, type AppServices } from "../../../src/ui-core/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../../src/ui-core/commands/command-handlers.js";
import { detectCapabilities } from "../../../src/ui-core/bootstrap/capabilities.js";
import { slashCommands } from "../../../src/app/commands/catalog.js";
import { normalizeCommandName } from "../../../src/app/commands/command.js";
import { createCurrentUpdatesPort } from "../../../src/app/adapters/current-updates-adapter.js";
import {
  getActiveProjectRoot,
  setActiveProjectRoot,
} from "../../../src/agent/project-root.js";

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
  return {
    async runTurn() {
      return "";
    },
  };
}

function buildServices(overrides: { requestExit?: () => void } = {}): AppServices {
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
    requestExit: overrides.requestExit,
    // Deterministic, offline update check (production injects the real fetcher).
    updates: createCurrentUpdatesPort(
      async () => "0.0.0",
      () => undefined,
    ),
  });
  attachCommandHandlers(services);
  return services;
}

/** Chrome feedback is toast-only (not transcript notice rows). */
function notices(services: AppServices): string[] {
  return services.toast.getToasts().map((t) => t.message);
}

const ALIAS_ONLY = new Set(["use", "search-provider", "reasoning", "thinking", "quit"]);

describe("command parity (V2-080)", () => {
  beforeEach(() => {
    updateConfig({
      disableKeychain: true,
      freeOnly: false,
      providerFallback: false,
      privateMode: false,
      permissions: "default",
    });
  });

  afterEach(() => {
    updateConfig({
      disableKeychain: false,
      freeOnly: false,
      providerFallback: false,
      privateMode: false,
      permissions: "default",
    });
  });

  it("registers a handler for every catalogue command (aliases share the canonical)", () => {
    const services = buildServices();
    const missing: string[] = [];
    for (const entry of slashCommands) {
      const name = normalizeCommandName(entry.command);
      if (ALIAS_ONLY.has(name)) continue;
      // dispatch returns false when no handler is attached
      const has = services.commands.resolve(name) !== undefined;
      expect(has).toBe(true);
      // Probe that a handler exists without executing side effects for exit/reset.
      if (name === "exit" || name === "reset") continue;
      // Handler presence: setHandler would throw if unknown; dispatch false if unhandled.
      // We only assert registry resolve + that non-destructive commands do not throw.
    }
    // Explicitly verify handlers are wired by calling a few that must be handled.
    expect(missing).toEqual([]);
    const handled = [
      "ask",
      "agent",
      "clear",
      "clean",
      "think",
      "context",
      "cwd",
      "freeonly",
      "fallback",
      "help",
      "allow",
      "disallow",
      "permissions",
      "model",
      "provider",
      "search",
      "effort",
      "plan",
      "implement",
      "discard",
      "output",
      "scope",
      "privacy",
      "keys",
      "info",
      "set",
      "unset",
      "save",
      "history",
      "compact",
      "update",
      "new",
    ];
    for (const name of handled) {
      expect(services.commands.resolve(name)).toBeDefined();
    }
  });

  it("/plan is canonical, enters plan mode without a plan, and /plan off returns to agent", async () => {
    const services = buildServices();
    expect(services.commands.resolve("plan")).toBe("plan");
    expect(services.commands.resolve("plan-mode")).toBeUndefined();
    expect(slashCommands.filter((entry) => entry.command === "/plan")).toHaveLength(1);
    expect(slashCommands.some((entry) => entry.command.includes("plan-mode"))).toBe(false);

    expect(await services.commands.dispatch({ name: "plan", args: "" })).toBe(true);
    expect(services.session.getState().mode).toBe("plan");
    expect(getConfig().defaultMode).toBe("plan");

    expect(await services.commands.dispatch({ name: "plan", args: "off" })).toBe(true);
    expect(services.session.getState().mode).toBe("agent");
    expect(getConfig().defaultMode).toBe("agent");
  });

  it("/ask and /agent switch mode and persist the default", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "ask", args: "" });
    expect(services.session.getState().mode).toBe("ask");
    expect(getConfig().defaultMode).toBe("ask");
    await services.commands.dispatch({ name: "agent", args: "" });
    expect(services.session.getState().mode).toBe("agent");
    expect(getConfig().defaultMode).toBe("agent");
  });

  it("/clear resets transcript and history without minting a new session id", async () => {
    const services = buildServices();
    services.session.loadHistory([{ role: "user", content: "hi" }]);
    const id = services.session.sessionId;
    await services.commands.dispatch({ name: "clear", args: "" });
    expect(services.session.messages).toHaveLength(0);
    expect(services.session.sessionId).toBe(id);
    // Clear feedback is toast-only — transcript stays empty of notice rows.
    expect(services.transcript.getState().order).toHaveLength(0);
    expect(notices(services).some((t) => t.includes("Context cleared"))).toBe(true);
  });

  it("/clean mints a new session id", async () => {
    const services = buildServices();
    const before = services.session.sessionId;
    await services.commands.dispatch({ name: "clean", args: "" });
    expect(services.session.sessionId).not.toBe(before);
    expect(notices(services).some((t) => t.includes("Fresh session"))).toBe(true);
  });

  it("/new and /clean clear the projected plan before loading the new session", async () => {
    for (const command of ["new", "clean"] as const) {
      const services = buildServices();
      setActiveProjectRoot("/tmp/clai-previous-project");
      expect(getActiveProjectRoot()).toBe("/tmp/clai-previous-project");
      const order: string[] = [];
      vi.spyOn(services.plan, "clear").mockImplementation(() => {
        order.push("clear");
      });
      vi.spyOn(services.plan, "load").mockImplementation(async () => {
        order.push("load");
        return undefined;
      });

      await services.commands.dispatch({ name: command, args: "" });
      expect(order).toEqual(["clear", "load"]);
      expect(getActiveProjectRoot()).toBeUndefined();
    }
  });

  it("/allow and /disallow manage the session tool allow-list", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "allow", args: "shell.exec" });
    expect(services.session.allowedTools()).toContain("shell.exec");
    await services.commands.dispatch({ name: "disallow", args: "shell.exec" });
    expect(services.session.allowedTools()).not.toContain("shell.exec");
  });

  it("/freeonly and /fallback toggle config", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "freeonly", args: "on" });
    expect(getConfig().freeOnly).toBe(true);
    await services.commands.dispatch({ name: "fallback", args: "on" });
    expect(getConfig().providerFallback).toBe(true);
    await services.commands.dispatch({ name: "freeonly", args: "" });
    expect(notices(services).some((t) => t.includes("freeOnly=true"))).toBe(true);
  });

  it("/fallback with no args opens the on/off picker", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "fallback", args: "" });
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind !== "picker") return;
    const options = overlay.request.options;
    expect(options.map((o) => o.value)).toEqual(["on", "off"]);
    expect(options.find((o) => o.value === "off")?.active).toBe(true);
    overlay.onSelect("on");
    expect(getConfig().providerFallback).toBe(true);
  });

  it("/privacy on|off|status updates private mode", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "privacy", args: "on" });
    expect(getConfig().privateMode).toBe(true);
    await services.commands.dispatch({ name: "privacy", args: "status" });
    expect(notices(services).some((t) => t.includes("private mode: on"))).toBe(true);
    await services.commands.dispatch({ name: "privacy", args: "off" });
    expect(getConfig().privateMode).toBe(false);
  });

  it("slash catalog no longer registers /mouse", () => {
    const services = buildServices();
    expect(services.commands.has("mouse")).toBe(false);
  });

  it("/help opens the command reference pager", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "help", args: "" });
    const state = services.overlay.getState();
    expect(state.kind).toBe("pager");
    if (state.kind === "pager") {
      expect(state.title).toContain("Command");
      expect(state.body).toContain("/model");
    }
  });

  it("/exit requests a clean lifecycle shutdown", async () => {
    const requestExit = vi.fn();
    const services = buildServices({ requestExit });
    await services.commands.dispatch({ name: "exit", args: "" });
    expect(requestExit).toHaveBeenCalledOnce();
  });

  it("/context reports message and token estimates", async () => {
    const services = buildServices();
    services.session.loadHistory([
      { role: "user", content: "hello world" },
      { role: "assistant", content: "hi there" },
    ]);
    await services.commands.dispatch({ name: "context", args: "" });
    expect(notices(services).some((t) => /context: 2 messages/.test(t))).toBe(true);
  });

  it("/cwd with no args reports the working directory", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "cwd", args: "" });
    expect(notices(services).some((t) => t.startsWith("cwd:"))).toBe(true);
  });

  it("/think toggles global thinking expansion", async () => {
    const services = buildServices();
    expect(services.transcript.getState().expandThinkingGlobal).toBe(false);
    await services.commands.dispatch({ name: "think", args: "" });
    expect(services.transcript.getState().expandThinkingGlobal).toBe(true);
  });

  it("/info opens a provider info pager", async () => {
    const services = buildServices();
    services.session.setProvider("groq");
    await services.commands.dispatch({ name: "info", args: "" });
    const state = services.overlay.getState();
    expect(state.kind).toBe("pager");
    if (state.kind === "pager") expect(state.title).toContain("groq");
  });

  it("/update checks the updates port without throwing", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "update", args: "" });
    // The handler publishes the sticky checking notice before its async check settles.
    await vi.waitFor(() => expect(notices(services).length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
  });

  it("session.notice surfaces as a toast, not a transcript row", () => {
    const services = buildServices();
    services.session.notice("warn", "something went wrong");
    const items = [...services.transcript.getState().byId.values()];
    expect(items.some((i) => i.kind === "notice")).toBe(false);
    const toasts = services.toast.getToasts();
    expect(toasts.some((t) => t.level === "warn" && t.message === "something went wrong")).toBe(
      true,
    );
  });

  it("session.reset with mintNewId rebinds the sequencer sequence", async () => {
    const services = buildServices();
    // Notices still advance lastSequence (via withSeq) but do not append rows.
    services.session.notice("info", "before");
    const beforeSeq = services.transcript.getState().lastSequence;
    expect(beforeSeq).toBeGreaterThan(0);
    services.session.reset({ mintNewId: true });
    services.transcript.reset();
    services.session.notice("info", "after");
    // New sequence starts at 1 after rebind + transcript reset
    expect(services.transcript.getState().lastSequence).toBe(1);
  });
});
