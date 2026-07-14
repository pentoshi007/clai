import { describe, expect, it } from "vitest";
import type { AgentPort, RunTurnHandlers, RunTurnRequest } from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";

class NoopAgentPort implements AgentPort {
  async runTurn(_request: RunTurnRequest, handlers: RunTurnHandlers): Promise<string> {
    handlers.onMessages?.([]);
    return "";
  }
}

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

function buildSession(): SessionController {
  return new SessionController({
    agent: new NoopAgentPort(),
    persistence: fakePersistence(),
    sessionId: "sess-queue",
  });
}

describe("SessionController queued-draft management (INPUT-007)", () => {
  it("edits a queued draft in place", () => {
    const session = buildSession();
    session.enqueue("first");
    session.enqueue("second");
    session.editQueued(0, "first (edited)");
    expect(session.queued()).toEqual(["first (edited)", "second"]);
  });

  it("ignores an edit at an out-of-range index", () => {
    const session = buildSession();
    session.enqueue("first");
    session.editQueued(5, "nope");
    expect(session.queued()).toEqual(["first"]);
  });

  it("reorders a queued draft to a later position", () => {
    const session = buildSession();
    session.enqueue("a");
    session.enqueue("b");
    session.enqueue("c");
    session.reorderQueued(0, 2);
    expect(session.queued()).toEqual(["b", "c", "a"]);
  });

  it("reorders a queued draft to an earlier position", () => {
    const session = buildSession();
    session.enqueue("a");
    session.enqueue("b");
    session.enqueue("c");
    session.reorderQueued(2, 0);
    expect(session.queued()).toEqual(["c", "a", "b"]);
  });

  it("ignores a reorder with an out-of-range index", () => {
    const session = buildSession();
    session.enqueue("a");
    session.enqueue("b");
    session.reorderQueued(0, 9);
    expect(session.queued()).toEqual(["a", "b"]);
  });

  it("ignores a reorder to the same index", () => {
    const session = buildSession();
    session.enqueue("a");
    session.enqueue("b");
    session.reorderQueued(1, 1);
    expect(session.queued()).toEqual(["a", "b"]);
  });

  it("removeQueued still removes by index after edits/reorders", () => {
    const session = buildSession();
    session.enqueue("a");
    session.enqueue("b");
    session.reorderQueued(0, 1);
    session.removeQueued(0);
    expect(session.queued()).toEqual(["a"]);
  });
});
