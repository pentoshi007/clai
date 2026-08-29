import { describe, expect, it, vi } from "vitest";
import { handleNew } from "../../src/ui-core/commands/session-commands.js";
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

function makeServices(
  requestSessionSwitch: (id: string, close: boolean, fresh?: boolean) => boolean,
): AppServices {
  return createCompositionRoot({
    agent: new SilentAgent(),
    persistence,
    requestSessionSwitch,
    capabilities: detectCapabilities({
      env: { COLORTERM: "truecolor" },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
  });
}

function markBusy(services: AppServices): void {
  const base = services.session.getState();
  vi.spyOn(services.session, "getState").mockReturnValue({ ...base, running: true });
}

describe("/new while a turn is running", () => {
  it("forks a fresh session into a new runtime instead of resetting", async () => {
    const calls: Array<[string, boolean, boolean | undefined]> = [];
    const requestSessionSwitch = vi.fn(
      (id: string, close: boolean, fresh?: boolean) => {
        calls.push([id, close, fresh]);
        return true;
      },
    );
    const services = makeServices(requestSessionSwitch);
    const originalId = services.session.sessionId;
    markBusy(services);
    const resetSpy = vi.spyOn(services.session, "reset");

    await handleNew(services);

    expect(calls).toHaveLength(1);
    const [freshId, close, fresh] = calls[0]!;
    expect(freshId).not.toBe(originalId);
    expect(close).toBe(false);
    expect(fresh).toBe(true);
    expect(resetSpy).not.toHaveBeenCalled();
    services.dispose();
  });

  it("falls back to an in-process reset when the broker is unavailable", async () => {
    const requestSessionSwitch = vi.fn(() => false);
    const services = makeServices(requestSessionSwitch);
    markBusy(services);
    const resetSpy = vi.spyOn(services.session, "reset");

    await handleNew(services);

    expect(requestSessionSwitch).toHaveBeenCalledTimes(1);
    expect(requestSessionSwitch).toHaveBeenCalledWith(
      expect.any(String),
      false,
      true,
    );
    expect(resetSpy).toHaveBeenCalledWith({ mintNewId: true });
    services.dispose();
  });

  it("resets in place when no turn is running", async () => {
    const requestSessionSwitch = vi.fn(() => true);
    const services = makeServices(requestSessionSwitch);
    const resetSpy = vi.spyOn(services.session, "reset");

    await handleNew(services);

    expect(requestSessionSwitch).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith({ mintNewId: true });
    services.dispose();
  });
});
