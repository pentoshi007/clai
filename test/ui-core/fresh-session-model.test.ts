import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClear, handleNew } from "../../src/ui-core/commands/session-commands.js";
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
import { saveSessionModel } from "../../src/store/session-model.js";

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
    requestSessionSwitch: () => false,
    capabilities: detectCapabilities({
      env: { COLORTERM: "truecolor" },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
  });
}

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clai-fresh-model-"));
  previous = process.env.CLAI_SESSION_MODEL_DIR;
  process.env.CLAI_SESSION_MODEL_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.CLAI_SESSION_MODEL_DIR;
  else process.env.CLAI_SESSION_MODEL_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("a fresh session keeps the last used provider and model", () => {
  it("carries the pair into /new instead of falling back to the global default", async () => {
    await saveSessionModel("sess-earlier", {
      provider: "fireworks",
      model: "accounts/fireworks/models/deepseek-v4-flash-0731",
    });
    const services = makeServices();
    const before = services.session.sessionId;

    await handleNew(services);

    const state = services.session.getState();
    expect(services.session.sessionId).not.toBe(before);
    expect(state.provider).toBe("fireworks");
    expect(state.model).toBe("accounts/fireworks/models/deepseek-v4-flash-0731");
  });

  it("carries the pair into /clear as well", async () => {
    await saveSessionModel("sess-earlier", {
      provider: "gemini",
      model: "gemini-3.5-flash",
    });
    const services = makeServices();

    await handleClear(services);

    const state = services.session.getState();
    expect(state.provider).toBe("gemini");
    expect(state.model).toBe("gemini-3.5-flash");
  });

  it("never pairs the inherited provider with another provider's model", async () => {
    await saveSessionModel("sess-earlier", {
      provider: "fireworks",
      model: "accounts/fireworks/models/deepseek-v4-flash-0731",
    });
    const services = makeServices();

    await handleNew(services);

    const state = services.session.getState();
    expect(state.model).not.toContain("kimi-k3");
    expect(state.model).toContain("fireworks");
  });

  it("leaves the session unbound when no past session recorded a model", async () => {
    const services = makeServices();
    await handleNew(services);
    const state = services.session.getState();
    expect(state.provider === undefined || typeof state.provider === "string").toBe(true);
  });
});
