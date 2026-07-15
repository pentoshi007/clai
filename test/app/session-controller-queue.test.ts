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

  it("takeQueued removes and returns the draft for composer edit", () => {
    const session = buildSession();
    session.enqueue("alpha");
    session.enqueue("beta");
    expect(session.takeQueued(0)).toBe("alpha");
    expect(session.queued()).toEqual(["beta"]);
    expect(session.takeQueued(9)).toBeUndefined();
  });

  it("sendQueuedNow while idle submits that prompt and leaves the rest queued", async () => {
    const session = buildSession();
    session.enqueue("first");
    session.enqueue("second");
    session.sendQueuedNow(0);
    // Idle path is async via submit().then(continueQueue).
    await new Promise((r) => setTimeout(r, 20));
    // first was taken; after submit completes continueQueue drains second.
    expect(session.queued()).toEqual([]);
    expect(session.getState().running).toBe(false);
  });

  it("sendQueuedNow while running aborts and prioritizes that prompt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const agent: AgentPort = {
      async runTurn(req, handlers) {
        seen.push(req.prompt);
        if (req.prompt === "slow") await gate;
        handlers.onMessages?.([]);
        return "";
      },
    };
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-send-now",
      emit: () => {},
    });
    const running = session.submit("slow");
    // Let the turn mark itself running.
    await new Promise((r) => setTimeout(r, 5));
    session.enqueue("queued-a");
    session.enqueue("queued-b");
    session.sendQueuedNow(1); // take queued-b as priority
    expect(session.queued()).toEqual(["queued-a"]);
    release();
    await running;
    // continueQueue is caller's job after onTurnEnd in the app; call it here.
    await session.continueQueue();
    expect(seen).toContain("slow");
    expect(seen).toContain("queued-b");
    // priority then remaining queue
    const bIdx = seen.indexOf("queued-b");
    const aIdx = seen.indexOf("queued-a");
    expect(bIdx).toBeGreaterThan(seen.indexOf("slow"));
    expect(aIdx).toBeGreaterThan(bIdx);
  });
});
