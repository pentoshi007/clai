import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort, RunTurnRequest } from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { providerIds, type ProviderId } from "../../src/types.js";

type Modules = {
  readonly SessionController: typeof import("../../src/app/controllers/session-controller.js").SessionController;
  readonly autoCompactTriggerTokens: typeof import("../../src/agent/request-budget.js").autoCompactTriggerTokens;
  readonly registerModelCatalogFacts: typeof import("../../src/llm/capabilities.js").registerModelCatalogFacts;
  readonly resetReasoningKnowledge: typeof import("../../src/llm/capabilities.js").resetReasoningKnowledge;
};

const PROVIDER = "anthropic" as const;
const MODEL = "claude-sonnet-4";

let configDir: string;
let dataDir: string;
let originalConfigDir: string | undefined;
let originalDataDir: string | undefined;
let modules: Modules;

const persistence = (): PersistencePort => ({
  async saveSession() {},
  async loadPlan() {
    return undefined;
  },
  async savePlan() {},
  async deletePlan() {},
});

function session(
  agent?: AgentPort,
  provider: ProviderId = PROVIDER,
  model: string = MODEL,
) {
  return new modules.SessionController({
    agent: agent ?? {
      async runTurn() {
        return createTurnOutcome({ status: "succeeded", answer: "", steps: 1, remainingCriteria: [] });
      },
    },
    persistence: persistence(),
    emit: () => {},
    provider,
    model,
  });
}

beforeEach(async () => {
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  originalDataDir = process.env.CLAI_DATA_DIR;
  configDir = await mkdtemp(join(tmpdir(), "clai-limit-trigger-config-"));
  dataDir = await mkdtemp(join(tmpdir(), "clai-limit-trigger-data-"));
  process.env.CLAI_CONFIG_DIR = configDir;
  process.env.CLAI_DATA_DIR = dataDir;
  vi.resetModules();
  const [controller, budget, capabilities] = await Promise.all([
    import("../../src/app/controllers/session-controller.js"),
    import("../../src/agent/request-budget.js"),
    import("../../src/llm/capabilities.js"),
  ]);
  modules = {
    SessionController: controller.SessionController,
    autoCompactTriggerTokens: budget.autoCompactTriggerTokens,
    registerModelCatalogFacts: capabilities.registerModelCatalogFacts,
    resetReasoningKnowledge: capabilities.resetReasoningKnowledge,
  };
  modules.resetReasoningKnowledge();
});

afterEach(async () => {
  modules.resetReasoningKnowledge();
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  if (originalDataDir === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = originalDataDir;
  await rm(configDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("auto-compaction trigger follows custom context limits", () => {
  it("moves the trigger with a custom limit and restores it on reset", () => {
    const controller = session();
    expect(controller.getState().contextLimit).toMatchObject({
      source: "model-table",
      tokens: 200_000,
      compactTriggerTokens: 140_000,
    });

    controller.setContextLimitTokens(120_000);
    expect(controller.getState().contextLimit).toMatchObject({
      source: "session-override",
      tokens: 120_000,
      compactTriggerTokens: modules.autoCompactTriggerTokens({
        provider: PROVIDER,
        model: MODEL,
        contextLimitTokens: 120_000,
      }),
    });
    expect(controller.getState().contextUsage?.contextLimit).toBe(120_000);

    controller.setContextLimitTokens(undefined);
    expect(controller.getState().contextLimit).toMatchObject({
      source: "model-table",
      tokens: 200_000,
      compactTriggerTokens: 140_000,
    });
    controller.dispose();
  });

  it("updates the trigger on an existing provider measurement", () => {
    const controller = session();
    controller.recordTokenUsage(
      { promptTokens: 90_000, completionTokens: 100, totalTokens: 90_100, exact: true },
      MODEL,
      PROVIDER,
    );
    controller.setContextLimitTokens(100_000);
    expect(controller.getState().contextSnapshot).toMatchObject({
      contextTokens: 90_000,
      limit: {
        tokens: 100_000,
        compactTriggerTokens: modules.autoCompactTriggerTokens({ contextLimitTokens: 100_000 }),
      },
    });

    controller.setContextLimitTokens(undefined);
    expect(controller.getState().contextSnapshot?.limit).toMatchObject({
      tokens: 200_000,
      compactTriggerTokens: 140_000,
    });
    controller.dispose();
  });

  it("overrides a provider window without changing measured usage and restores it on reset", () => {
    modules.registerModelCatalogFacts(PROVIDER, { id: MODEL, contextTokens: 200_000 });
    const controller = session();
    controller.recordTokenUsage(
      { promptTokens: 90_000, completionTokens: 100, totalTokens: 90_100, exact: true },
      MODEL,
      PROVIDER,
    );
    controller.setContextLimitTokens(500_000);

    expect(controller.getState()).toMatchObject({
      contextLimit: {
        source: "session-override",
        tokens: 500_000,
        requestedTokens: 500_000,
        providerTokens: 200_000,
        compactTriggerTokens: 400_000,
      },
      contextUsage: { contextTokens: 90_000, contextLimit: 500_000, exact: true },
      contextChip: "ctx 90,000/500k 18%",
    });
    const reopened = session();
    expect(reopened.getState().contextUsage?.contextLimit).toBe(500_000);
    reopened.dispose();

    modules.registerModelCatalogFacts(PROVIDER, { id: MODEL, contextTokens: 250_000 });
    expect(controller.getState().contextLimit).toMatchObject({
      tokens: 500_000,
      providerTokens: 250_000,
      compactTriggerTokens: 400_000,
    });
    controller.setContextLimitTokens(undefined);
    expect(controller.getState()).toMatchObject({
      contextLimit: {
        source: "model-catalog",
        tokens: 250_000,
        compactTriggerTokens: 200_000,
      },
      contextUsage: { contextTokens: 90_000, contextLimit: 250_000, exact: true },
      contextChip: "ctx 90,000/250k 36%",
    });
    controller.dispose();
  });

  it("lets a running turn read limit changes and resets live", async () => {
    let request: RunTurnRequest | undefined;
    const controller = session({
      async runTurn(next) {
        request = next;
        return createTurnOutcome({ status: "succeeded", answer: "", steps: 1, remainingCriteria: [] });
      },
    });
    await controller.submit("go");

    expect(request?.getContextLimitTokens?.(PROVIDER, MODEL)).toBeUndefined();
    controller.setContextLimitTokens(64_000);
    expect(request?.getContextLimitTokens?.(PROVIDER, MODEL)).toBe(64_000);
    controller.setContextLimitTokens(undefined);
    expect(request?.getContextLimitTokens?.(PROVIDER, MODEL)).toBeUndefined();
    controller.dispose();
  });

  it("shows route-specific custom limits for every built-in provider", () => {
    const model = "custom-context-route";
    for (const provider of providerIds) {
      const controller = session(undefined, provider, model);
      controller.setContextLimitTokens(120_000);
      expect(controller.getState()).toMatchObject({
        contextLimit: {
          source: "session-override",
          tokens: 120_000,
          compactTriggerTokens: modules.autoCompactTriggerTokens({
            provider,
            model,
            contextLimitTokens: 120_000,
          }),
        },
        contextUsage: { contextLimit: 120_000 },
        contextChip: "ctx 0/120k 0%",
      });

      controller.setContextLimitTokens(undefined);
      expect(controller.getState()).toMatchObject({
        contextLimit: {
          source: "default",
          tokens: 200_000,
          compactTriggerTokens: modules.autoCompactTriggerTokens({ provider, model }),
        },
        contextUsage: { contextLimit: 200_000 },
        contextChip: "ctx 0/200k 0%",
      });
      controller.dispose();
    }
  });

  it("keeps free-1 and free-2 custom limits independent and resets each trigger", () => {
    const modelOne = "free-1/custom-free-route";
    const modelTwo = "free-2/custom-free-route";
    const freeOne = session(undefined, "free", modelOne);
    const freeTwo = session(undefined, "free", modelTwo);
    freeOne.setContextLimitTokens(80_000);
    freeTwo.setContextLimitTokens(130_000);

    expect(freeOne.getState().contextChip).toBe("ctx 0/80k 0%");
    expect(freeOne.getState().contextLimit?.compactTriggerTokens).toBe(
      modules.autoCompactTriggerTokens({
        provider: "free",
        model: modelOne,
        contextLimitTokens: 80_000,
      }),
    );
    expect(freeTwo.getState().contextChip).toBe("ctx 0/130k 0%");
    expect(freeTwo.getState().contextLimit?.compactTriggerTokens).toBe(
      modules.autoCompactTriggerTokens({
        provider: "free",
        model: modelTwo,
        contextLimitTokens: 130_000,
      }),
    );

    freeOne.setContextLimitTokens(undefined);
    expect(freeOne.getState().contextUsage?.contextLimit).toBe(200_000);
    expect(freeOne.getState().contextLimit?.compactTriggerTokens).toBe(
      modules.autoCompactTriggerTokens({ provider: "free", model: modelOne }),
    );
    expect(freeTwo.getState().contextUsage?.contextLimit).toBe(130_000);
    freeTwo.setContextLimitTokens(undefined);
    expect(freeTwo.getState().contextLimit).toMatchObject({
      source: "default",
      tokens: 200_000,
      compactTriggerTokens: modules.autoCompactTriggerTokens({ provider: "free", model: modelTwo }),
    });
    freeOne.dispose();
    freeTwo.dispose();
  });
});
