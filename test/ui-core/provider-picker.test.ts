import { describe, expect, it, vi } from "vitest";

import { handleProvider } from "../../src/ui-core/commands/picker-commands.js";
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
import { filterPickerOptions } from "../../src/ui-core/rendering/picker-filter.js";
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

async function openProviderPicker(services: AppServices): Promise<{
  searchDescription: boolean | undefined;
  options: readonly PickerOption[];
}> {
  let captured:
    | { searchDescription: boolean | undefined; options: readonly PickerOption[] }
    | undefined;
  const openPicker = vi
    .spyOn(services.overlay, "openPicker")
    .mockImplementation((request) => {
      captured = {
        searchDescription: request.searchDescription,
        options: request.options as readonly PickerOption[],
      };
    });
  handleProvider(services, { name: "provider", args: "" });
  await vi.waitFor(() => {
    if (!captured) throw new Error("picker was not opened");
  });
  openPicker.mockRestore();
  if (!captured) throw new Error("picker was not opened");
  return captured;
}

describe("/provider search is scoped to provider names", () => {
  it("does not search the configured model of each provider", async () => {
    const services = makeServices();
    const picker = await openProviderPicker(services);
    expect(picker.searchDescription).toBe(false);
  });

  it("keeps every provider reachable by its own name", async () => {
    const services = makeServices();
    const picker = await openProviderPicker(services);
    const rows = picker.options.filter((option) => option.value === "bynara");
    expect(rows).toHaveLength(1);
    const matched = filterPickerOptions([...picker.options], "bynara", {
      searchDescription: picker.searchDescription ?? true,
    });
    expect(matched[0]?.value).toBe("bynara");
  });

  it("shows the configured model as the row description without matching it", async () => {
    const services = makeServices();
    const picker = await openProviderPicker(services);
    const bynara = picker.options.find((option) => option.value === "bynara");
    expect(bynara?.description).toBeTruthy();
    const matched = filterPickerOptions([...picker.options], bynara!.description!, {
      searchDescription: picker.searchDescription ?? true,
    });
    expect(matched.some((option) => option.value === "bynara")).toBe(false);
  });
});
