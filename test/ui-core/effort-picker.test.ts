import { describe, expect, it, vi } from "vitest";

import { handleReasoning } from "../../src/ui-core/commands/picker-commands.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import type { PickerOption } from "../../src/ui-core/state/types.js";

class SilentAgent implements AgentPort {
  async runTurn(
    _request: RunTurnRequest,
    _handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    return createTurnOutcome({
      status: "succeeded",
      answer: "",
      steps: 0,
      remainingCriteria: [],
    });
  }
}

const persistence: PersistencePort = {
  async saveSession() {},
  async loadPlan() {
    return undefined;
  },
  async savePlan() {},
  async deletePlan() {},
};

function makeServices(): AppServices {
  return createCompositionRoot({
    agent: new SilentAgent(),
    persistence,
    capabilities: detectCapabilities({
      env: { COLORTERM: "truecolor" },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
  });
}

function openEffortPicker(
  services: AppServices,
  provider: string,
  model: string,
): { title: string; options: readonly PickerOption[] } {
  services.session.setProvider?.(provider as never);
  services.session.setModel?.(model);
  let captured: { title: string; options: readonly PickerOption[] } | undefined;
  const openPicker = vi
    .spyOn(services.overlay, "openPicker")
    .mockImplementation((request) => {
      captured = {
        title: request.title ?? "",
        options: request.options as readonly PickerOption[],
      };
    });
  handleReasoning(services, { name: "effort", args: "" });
  openPicker.mockRestore();
  if (!captured) throw new Error("picker was not opened");
  return captured;
}

describe("/effort offers only what the route accepts", () => {
  it("shows exactly the advertised efforts for a route that publishes three", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "tokenrouter", "moonshotai/kimi-k3");
    const values = picker.options.map((option) => option.value);
    expect(values.filter((value) => value !== "off")).toEqual(["low", "high", "max"]);
  });

  it("offers no off entry when the route always generates reasoning", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "tokenrouter", "moonshotai/kimi-k3");
    expect(picker.options.map((option) => option.value)).not.toContain("off");
  });

  it("offers the whole scale when the route advertises nothing", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "ollama", "llama3.1:8b");
    expect(picker.options.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("carries the provenance of the capability in the title", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "tokenrouter", "moonshotai/kimi-k3");
    expect(picker.title).toMatch(/via (observed|catalog|pattern|rejected|unknown)/);
  });
});

describe("/effort matches the selected gemini model", () => {
  it("offers gemini 3 flash the thinking levels it accepts and no higher alias", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "gemini", "gemini-3.5-flash");
    expect(picker.options.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("drops minimal for gemini 3 pro, which has no minimal thinking level", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "gemini", "gemini-3.1-pro");
    expect(picker.options.map((option) => option.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("offers budget levels for gemini 2.5 flash", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "gemini", "gemini-2.5-flash");
    expect(picker.options.map((option) => option.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("never offers off for gemini 2.5 pro, which cannot disable thinking", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "gemini", "gemini-2.5-pro");
    expect(picker.options.map((option) => option.value)).toEqual(["low", "medium", "high"]);
  });

  it("offers only off for a gemini model with no thinking config", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "gemini", "gemini-2.0-flash");
    expect(picker.options.map((option) => option.value)).toEqual(["off"]);
  });
});

describe("/effort on a route known not to reason", () => {
  it("offers only off when the route never returns reasoning", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "bynara", "ling-3.0-flash-free");
    expect(picker.options.map((option) => option.value)).toEqual(["off"]);
  });

  it("still offers the whole scale when support is merely unknown", () => {
    const services = makeServices();
    const picker = openEffortPicker(services, "ollama", "llama3.1:8b");
    expect(picker.options.map((option) => option.value)).toContain("medium");
  });
});
