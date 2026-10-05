import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { getProvider } from "../../src/llm/router.js";
import { getConfig } from "../../src/store/config.js";
import type { ProviderId } from "../../src/types.js";
import { resetSessionModelCache } from "../../src/store/session-model.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: ProviderId) => provider === "qoder"
      ? { keys: [{ id: "test-qoder-slot", value: JSON.stringify({ uid: "picker-test", accessToken: "fixture-access", machineId: "fixture-machine", machineToken: "fixture-token", encryptUserInfo: "fixture-signature", key: "fixture-key" }), createdAt: 1 }], activeIndex: 0, source: "fallback" as const }
      : actual.getProviderKeys(provider),
    getProviderSecret: async (provider: ProviderId) => provider === "qoder"
      ? { value: JSON.stringify({ uid: "picker-test", accessToken: "fixture-access", machineId: "fixture-machine", machineToken: "fixture-token", encryptUserInfo: "fixture-signature", key: "fixture-key" }), source: "fallback" as const }
      : actual.getProviderSecret(provider),
  };
});

let modelDir: string;
let previousModelDir: string | undefined;

beforeEach(() => {
  modelDir = mkdtempSync(join(tmpdir(), "clai-provider-picker-"));
  previousModelDir = process.env.CLAI_SESSION_MODEL_DIR;
  process.env.CLAI_SESSION_MODEL_DIR = modelDir;
  resetSessionModelCache();
});

afterEach(async () => {
  resetSessionModelCache();
  if (previousModelDir === undefined) delete process.env.CLAI_SESSION_MODEL_DIR;
  else process.env.CLAI_SESSION_MODEL_DIR = previousModelDir;
  await rm(modelDir, { recursive: true, force: true });
});

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
  it("selects Qoder through the shared picker callback without changing the global provider", async () => {
    const services = makeServices();
    const defaultProvider = getConfig().defaultProvider;
    const listModels = vi.spyOn(getProvider("qoder"), "listModels").mockResolvedValue(["qfmodel:free"]);
    try {
      handleProvider(services, { name: "provider", args: "" });
      await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
      services.overlay.selectPicker("qoder");
      await vi.waitFor(() => expect(services.session.getState().provider).toBe("qoder"));
      await vi.waitFor(() => expect(listModels).toHaveBeenCalled());
      expect(getConfig().defaultProvider).toBe(defaultProvider);
      expect(services.session.getState().model).toBe("qfmodel:free");
    } finally {
      listModels.mockRestore();
      services.dispose();
    }
  });

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

  it("shows the base url in parens as the row description without matching it", async () => {
    const services = makeServices();
    const picker = await openProviderPicker(services);
    const bynara = picker.options.find((option) => option.value === "bynara");
    expect(bynara?.description).toBe("(https://router.bynara.id/v1)");
    const openai = picker.options.find((option) => option.value === "openai");
    expect(openai?.description).toBe("(https://api.openai.com/v1)");
    const omnirush = picker.options.find((option) => option.value === "omnirush");
    expect(omnirush?.description).toBe("(https://omnirush.ai/omnirush/v1)");
    const qoder = picker.options.find((option) => option.value === "qoder");
    expect(qoder?.description).toBe("(https://api1.qoder.sh)");
    expect(filterPickerOptions([...picker.options], "qoder", { searchDescription: false })).toEqual([qoder]);
    expect(filterPickerOptions([...picker.options], "api1.qoder.sh", { searchDescription: false })).toEqual([]);
    const matched = filterPickerOptions([...picker.options], bynara!.description!, {
      searchDescription: picker.searchDescription ?? true,
    });
    expect(matched.some((option) => option.value === "bynara")).toBe(false);
  });
});
