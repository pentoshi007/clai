import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleModel, handleProvider } from "../../src/ui-core/commands/picker-commands.js";
import { getProvider } from "../../src/llm/router.js";
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
import { getConfig } from "../../src/store/config.js";
import {
  loadSessionModelBinding,
  resetSessionModelCache,
} from "../../src/store/session-model.js";

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

let modelDir: string;

beforeEach(() => {
  modelDir = mkdtempSync(join(tmpdir(), "clai-picker-model-"));
  process.env.CLAI_SESSION_MODEL_DIR = modelDir;
  resetSessionModelCache();
});

afterEach(async () => {
  resetSessionModelCache();
  delete process.env.CLAI_SESSION_MODEL_DIR;
  await rm(modelDir, { recursive: true, force: true });
});

describe("/model writes per session, not global config", () => {
  it("leaves the global default provider and model map untouched", async () => {
    const services = makeServices();
    const sessionId = services.session.sessionId;
    const defaultProviderBefore = getConfig().defaultProvider;
    const defaultModelBefore = getConfig().defaultModel;
    const providerModelsBefore = JSON.stringify(getConfig().providerModels ?? {});

    await handleModel(services, { name: "model", args: "custom-model-xyz" });

    expect(getConfig().defaultProvider).toBe(defaultProviderBefore);
    expect(getConfig().defaultModel).toBe(defaultModelBefore);
    expect(JSON.stringify(getConfig().providerModels ?? {})).toBe(providerModelsBefore);

    expect(services.session.getState().model).toBe("custom-model-xyz");
    await vi.waitFor(async () => {
      const binding = await loadSessionModelBinding(sessionId);
      expect(binding?.model).toBe("custom-model-xyz");
    });
    services.dispose();
  });

  it("shows the current session model as active in the picker", async () => {
    const services = makeServices();
    const previousKey = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-test-model-picker";
    const provider = getProvider("nvidia");
    const listModels = vi
      .spyOn(provider, "listModels" as "listModels")
      .mockResolvedValue(["session-only-model", "other-model"]);
    services.session.setProvider("nvidia");
    services.session.setModel("session-only-model");

    try {
      await handleModel(services, { name: "model", args: "" });
      const overlay = services.overlay.getState();
      expect(overlay.kind).toBe("picker");
      if (overlay.kind !== "picker") throw new Error("model picker did not open");
      expect(
        overlay.request.options.find(
          (option) => option.value === "session-only-model",
        )?.active,
      ).toBe(true);
    } finally {
      listModels.mockRestore();
      if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = previousKey;
      services.dispose();
    }
  });

  it("switches providers per session without changing the global default", async () => {
    const services = makeServices();
    const sessionId = services.session.sessionId;
    const defaultProviderBefore = getConfig().defaultProvider;
    const previousKey = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-test-provider-picker";
    const provider = getProvider("nvidia");
    const listModels = vi
      .spyOn(provider, "listModels" as "listModels")
      .mockResolvedValue(["openai/gpt-oss-20b"]);

    try {
      handleProvider(services, { name: "provider", args: "nvidia" });
      await vi.waitFor(() => {
        expect(services.session.getState().provider).toBe("nvidia");
      });

      expect(getConfig().defaultProvider).toBe(defaultProviderBefore);
      await vi.waitFor(async () => {
        expect(await loadSessionModelBinding(sessionId)).toEqual({
          provider: "nvidia",
          model: "openai/gpt-oss-20b",
        });
      });
    } finally {
      listModels.mockRestore();
      if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = previousKey;
      services.dispose();
    }
  });
});
