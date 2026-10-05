import { afterEach, describe, expect, it, vi } from "vitest";

const prefetch = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../src/llm/catalog-prefetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/catalog-prefetch.js")>(),
  prefetchProviderCatalog: (provider: unknown) => prefetch(provider),
}));

import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import * as config from "../../src/store/config.js";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import {
  clearModelCatalogFacts,
  registerModelCatalogFacts,
} from "../../src/llm/capabilities.js";

class NoopAgent implements AgentPort {
  calls = 0;

  async runTurn(
    _request: RunTurnRequest,
    handlers: RunTurnHandlers,
  ) {
    this.calls += 1;
    handlers.onMessages?.([]);
    return createTurnOutcome({
      status: "succeeded",
      answer: "ok",
      steps: 1,
      remainingCriteria: [],
    });
  }
}

function persistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

function build(agent = new NoopAgent()): SessionController {
  return new SessionController({
    agent,
    persistence: persistence(),
    emit: () => {},
    sessionId: "catalog-refresh",
    provider: "kiro",
    model: "old-model",
  });
}

afterEach(() => {
  prefetch.mockReset();
  prefetch.mockResolvedValue(undefined);
  clearModelCatalogFacts();
  vi.useRealTimers();
});

describe("SessionController provider catalog refresh", () => {
  it("prefetches on model switch and refreshes the effective limit", async () => {
    const session = build();
    session.loadHistory([{ role: "user", content: "resume" }], {
      contextUsage: {
        contextTokens: 125_000,
        contextLimit: 0,
        lastCompletionTokens: 0,
        sessionPromptTokens: 0,
        sessionCompletionTokens: 0,
        exact: false,
      },
    });
    session.setProvider("kiro");
    prefetch.mockClear();
    let release: (() => void) | undefined;
    prefetch.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    session.setModel("catalog-model");
    expect(prefetch).toHaveBeenCalledWith("kiro");
    expect(session.getState().contextSnapshot?.limit.source).not.toBe("model-catalog");

    registerModelCatalogFacts("kiro", {
      id: "catalog-model",
      contextTokens: 1_000_000,
    });
    release?.();
    await vi.waitFor(() => {
      expect(session.getState().contextSnapshot?.limit).toMatchObject({
        source: "model-catalog",
        tokens: 1_000_000,
        compactTriggerTokens: 800_000,
      });
    });
    session.dispose();
  });

  it("does not read configuration after disposal when catalog prefetch completes", async () => {
    const session = build();
    let release: (() => void) | undefined;
    prefetch.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    session.setProvider(undefined);
    const getConfig = vi.spyOn(config, "getConfig");
    try {
      session.dispose();
      getConfig.mockClear();
      release?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getConfig).not.toHaveBeenCalled();
    } finally {
      getConfig.mockRestore();
    }
  });

  it("does not block dispatch when catalog prefetch stalls", async () => {
    prefetch.mockReturnValue(new Promise<void>(() => {}));
    const agent = new NoopAgent();
    const session = build(agent);

    await expect(session.submit("continue")).resolves.toMatchObject({
      status: "completed",
    });
    expect(agent.calls).toBe(1);
    session.dispose();
  });
});
