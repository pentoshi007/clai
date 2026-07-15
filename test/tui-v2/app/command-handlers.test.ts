import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asPlanId, asSessionId, asToolCallId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { getConfig, updateConfig } from "../../../src/store/config.js";
import * as keys from "../../../src/store/keys.js";
import { createCompositionRoot, type AppServices } from "../../../src/tui-v2/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../../src/tui-v2/app/command-handlers.js";
import { detectCapabilities } from "../../../src/tui-v2/bootstrap/capabilities.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";

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

function buildServices(): AppServices {
  const services = createCompositionRoot({
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("command handlers (V2-072..075)", () => {
  beforeEach(() => {
    updateConfig({ disableKeychain: true });
  });

  it("/variants with no args opens a reasoning picker; selecting applies it", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "variants", args: "" });
    const state = services.overlay.getState();
    expect(state.kind).toBe("picker");
    if (state.kind === "picker") {
      expect(state.request.title).toContain("Reasoning");
      services.overlay.selectPicker("high");
    }
    expect(getConfig().thinking).toEqual({ enabled: true, effort: "high" });
    expect(services.overlay.getState().kind).toBe("none");
  });

  it("/variants off disables thinking directly, without opening a picker", async () => {
    const services = buildServices();
    updateConfig({ thinking: { enabled: true, effort: "medium" } });
    await services.commands.dispatch({ name: "variants", args: "off" });
    expect(getConfig().thinking.enabled).toBe(false);
    expect(services.overlay.getState().kind).toBe("none");
  });

  it("/permissions opens a two-option picker defaulting to the current value", async () => {
    const services = buildServices();
    updateConfig({ permissions: "default" });
    await services.commands.dispatch({ name: "permissions", args: "" });
    const state = services.overlay.getState();
    if (state.kind === "picker") {
      expect(state.request.options.map((o) => o.value)).toEqual(["default", "allow-all"]);
      services.overlay.selectPicker("allow-all");
    }
    expect(getConfig().permissions).toBe("allow-all");
  });

  it("/permissions allow-all applies directly", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "permissions", args: "allow-all" });
    expect(getConfig().permissions).toBe("allow-all");
  });

  it("/model <name> sets the model directly and persists it for the provider", async () => {
    const services = buildServices();
    services.session.setProvider("groq");
    await services.commands.dispatch({ name: "model", args: "llama-3.3-70b-versatile" });
    expect(services.session.getState().model).toBe("llama-3.3-70b-versatile");
    expect(getConfig().providerModels.groq).toBe("llama-3.3-70b-versatile");
  });

  it("/model with no args opens a picker (static known list when API empty)", async () => {
    const services = buildServices();
    services.session.setProvider("groq");
    const { getProvider } = await import("../../../src/llm/router.js");
    const impl = getProvider("groq");
    // Force known-list path without a network call.
    const spy = vi.spyOn(impl, "listModels" as "listModels").mockResolvedValue([]);

    await services.commands.dispatch({ name: "model", args: "" });
    await waitUntil(() => services.overlay.getState().kind === "picker");
    const state = services.overlay.getState();
    expect(state.kind).toBe("picker");
    if (state.kind === "picker") {
      expect(state.request.options.length).toBeGreaterThan(0);
      expect(state.request.title).not.toMatch(/· live$/);
      services.overlay.selectPicker(state.request.options[0]!.value);
    }
    expect(services.session.getState().model).toBe(getConfig().providerModels.groq);
    spy.mockRestore();
  });

  it("/model refreshes via provider.listModels when available", async () => {
    const services = buildServices();
    services.session.setProvider("groq");
    const { getProvider } = await import("../../../src/llm/router.js");
    const impl = getProvider("groq");
    const live = ["live-model-a", "live-model-b", "llama-3.3-70b-versatile"];
    const listModels = vi.fn(async () => live);
    const spy = vi.spyOn(impl, "listModels" as "listModels").mockImplementation(listModels);

    await services.commands.dispatch({ name: "model", args: "" });
    await waitUntil(() => services.overlay.getState().kind === "picker");
    const state = services.overlay.getState();
    expect(listModels).toHaveBeenCalled();
    expect(state.kind).toBe("picker");
    if (state.kind === "picker") {
      expect(state.request.title).toMatch(/live/i);
      expect(state.request.options.map((o) => o.value)).toEqual(
        expect.arrayContaining(["live-model-a", "live-model-b"]),
      );
      services.overlay.selectPicker("live-model-a");
    }
    expect(services.session.getState().model).toBe("live-model-a");
    spy.mockRestore();
  });

  it("/model falls back to known models when listModels fails", async () => {
    const services = buildServices();
    services.session.setProvider("groq");
    const { getProvider } = await import("../../../src/llm/router.js");
    const impl = getProvider("groq");
    const spy = vi
      .spyOn(impl, "listModels" as "listModels")
      .mockRejectedValue(new Error("network down"));

    await services.commands.dispatch({ name: "model", args: "" });
    await waitUntil(() => services.overlay.getState().kind === "picker");
    const state = services.overlay.getState();
    expect(state.kind).toBe("picker");
    if (state.kind === "picker") {
      expect(state.request.options.length).toBeGreaterThan(0);
      expect(state.request.title).not.toMatch(/· live$/);
      services.overlay.close();
    }
    spy.mockRestore();
  });

  it("/history with no local messages settles without hanging", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "history", args: "" });
    // Disk may have saved sessions (picker) or none (notice) — either is fine.
    const kind = services.overlay.getState().kind;
    expect(["none", "picker"]).toContain(kind);
    if (kind === "picker") services.overlay.close();
  });

  it("/history opens a picker that includes the current session when messages exist", async () => {
    const services = buildServices();
    services.session.loadHistory([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    const dispatched = services.commands.dispatch({ name: "history", args: "" });
    await waitUntil(() => services.overlay.getState().kind === "picker");
    await dispatched;
    const state = services.overlay.getState();
    expect(state.kind).toBe("picker");
    if (state.kind === "picker") {
      expect(state.request.options[0]?.value).toBe("__current__");
      services.overlay.selectPicker("__current__");
    }
    expect(services.overlay.getState().kind).toBe("none");
  });

  it("/plan opens the pager with the current plan's detail", async () => {
    const services = buildServices();
    services.plan.observe(
      new EventSequencer(asSessionId("s1")).build(
        "plan-updated",
        {
          planId: asPlanId("p1"),
          plan: {
            sessionId: "s1",
            goal: "Ship it",
            detail: "step by step",
            tasks: [],
            status: "draft",
            kind: "coding",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        undefined,
      ),
    );
    await services.commands.dispatch({ name: "plan", args: "" });
    await waitUntil(() => services.overlay.getState().kind === "pager");
    const state = services.overlay.getState();
    expect(state.kind).toBe("pager");
    if (state.kind === "pager") {
      expect(state.title).toContain("Ship it");
      expect(state.body).toContain("step by step");
    }
  });

  it("/output last opens the pager with the last tool call's spooled output", async () => {
    const services = buildServices();
    const sequencer = new EventSequencer(asSessionId("s1"));
    const toolCallId = asToolCallId("tool-1");
    services.session.spool.append(toolCallId, "hello from the tool\n");
    services.transcript.dispatch(
      sequencer.build("tool-call", { toolCallId, name: "fs.read", argsDisplay: "a.txt" }, undefined),
    );
    services.transcript.dispatch(
      sequencer.build(
        "tool-result",
        { toolCallId, ok: true, exitCode: 0, summary: "done" },
        undefined,
      ),
    );
    await services.commands.dispatch({ name: "output", args: "last" });
    const state = services.overlay.getState();
    expect(state.kind).toBe("pager");
    if (state.kind === "pager") expect(state.body).toContain("hello from the tool");
  });

  it("/output with no args toggles global tool-output expansion", async () => {
    const services = buildServices();
    const sequencer = new EventSequencer(asSessionId("s1"));
    const toolCallId = asToolCallId("tool-1");
    services.transcript.dispatch(
      sequencer.build("tool-call", { toolCallId, name: "fs.read", argsDisplay: "a.txt" }, undefined),
    );
    expect(services.transcript.getState().expandOutputGlobal).toBe(false);
    await services.commands.dispatch({ name: "output", args: "" });
    expect(services.transcript.getState().expandOutputGlobal).toBe(true);
    expect(services.overlay.getState().kind).toBe("none");
  });

  it("/output with no tool calls yet emits a notice", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "output", args: "" });
    expect(services.overlay.getState().kind).toBe("none");
    const notices = [...services.transcript.getState().byId.values()].filter((i) => i.kind === "notice");
    expect(notices.some((n) => n.kind === "notice" && n.text.includes("no tool output"))).toBe(true);
  });

  it("activates a provider that already has a stored key without prompting for a secret", async () => {
    const services = buildServices();
    await services.commands.dispatch({ name: "provider", args: "ollama" });
    expect(services.session.getState().provider).toBe("ollama");
    expect(services.overlay.getState().kind).toBe("none");
  });

  it("prompts for a secret when a provider has no key, and applies it once entered", async () => {
    const original = process.env.BYNARA_API_KEY;
    delete process.env.BYNARA_API_KEY;
    const getSecret = vi.spyOn(keys, "getProviderSecret").mockResolvedValue({ source: "missing" });
    const setSecret = vi.spyOn(keys, "setProviderSecret").mockResolvedValue("fallback");
    try {
      const services = buildServices();
      const dispatched = services.commands.dispatch({ name: "provider", args: "bynara" });
      await waitUntil(() => services.overlay.getState().kind === "secret");
      const state = services.overlay.getState();
      expect(state.kind).toBe("secret");
      if (state.kind === "secret") services.overlay.answerSecret("test-key-12345678");
      await dispatched;
      await waitUntil(() => services.session.getState().provider === "bynara");
      expect(setSecret).toHaveBeenCalledWith("bynara", "test-key-12345678");
      expect(services.overlay.getState().kind).toBe("none");
    } finally {
      getSecret.mockRestore();
      setSecret.mockRestore();
      if (original === undefined) delete process.env.BYNARA_API_KEY;
      else process.env.BYNARA_API_KEY = original;
    }
  });

  afterEach(() => {
    updateConfig({ disableKeychain: false, permissions: "default" });
  });
});
