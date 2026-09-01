import { describe, expect, it, vi } from "vitest";
import type { AgentPort, RunTurnHandlers, RunTurnRequest } from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";

const succeeded = (answer = ""): TurnOutcome =>
  createTurnOutcome({ status: "succeeded", answer, steps: 1, remainingCriteria: [] });

class NoopAgentPort implements AgentPort {
  async runTurn(_request: RunTurnRequest, handlers: RunTurnHandlers): Promise<TurnOutcome> {
    handlers.onMessages?.([]);
    return succeeded();
  }
}

class CapturingAgentPort extends NoopAgentPort {
  lastRequest: RunTurnRequest | undefined;

  override async runTurn(request: RunTurnRequest, handlers: RunTurnHandlers): Promise<TurnOutcome> {
    this.lastRequest = request;
    return super.runTurn(request, handlers);
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

function buildSession(agent: AgentPort = new NoopAgentPort()): SessionController {
  return new SessionController({
    agent,
    persistence: fakePersistence(),
    emit: () => {},
    sessionId: "sess-queue",
  });
}

describe("SessionController queued-draft management (INPUT-007)", () => {
  it("passes a provider/model session context limit to the agent and clears it", async () => {
    const agent = new CapturingAgentPort();
    const session = buildSession(agent);

    session.setContextLimitTokens(1_000_000);
    await session.submit("first");
    expect(agent.lastRequest?.contextLimitTokens).toBe(1_000_000);

    session.setContextLimitTokens(undefined);
    await session.submit("second");
    expect(agent.lastRequest?.contextLimitTokens).toBeUndefined();
  });

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

  it("sendQueuedNow while idle submits that prompt and drains the rest", async () => {
    const session = buildSession();
    session.enqueue("first");
    session.enqueue("second");
    session.sendQueuedNow(0);
    await vi.waitFor(() => {
      expect(session.queued()).toEqual([]);
      expect(session.getState().running).toBe(false);
    });
  });

  it("drains queued prompts after natural completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const agent: AgentPort = {
      async runTurn(request) {
        seen.push(request.prompt);
        if (request.prompt === "active") await gate;
        return succeeded();
      },
    };
    const session = buildSession(agent);
    const running = session.submit("active");
    await vi.waitFor(() => expect(session.getState().running).toBe(true));
    session.enqueue("queued-a");
    session.enqueue("queued-b");
    release();
    await running;
    await vi.waitFor(() => {
      expect(seen).toEqual(["active", "queued-a", "queued-b"]);
      expect(session.queued()).toEqual([]);
    });
  });

  it("keeps queued prompts after an ordinary abort", async () => {
    const agent: AgentPort = {
      async runTurn(_request, handlers) {
        await new Promise<void>((_resolve, reject) => {
          handlers.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        return succeeded();
      },
    };
    const session = buildSession(agent);
    const running = session.submit("active");
    await vi.waitFor(() => expect(session.getState().running).toBe(true));
    session.enqueue("queued-a");
    session.enqueue("queued-b");
    session.abort();
    expect((await running).status).toBe("aborted");
    expect(session.queued()).toEqual(["queued-a", "queued-b"]);
  });

  it("sendQueuedNow while running aborts and prioritizes that prompt", async () => {
    const seen: string[] = [];
    const agent: AgentPort = {
      async runTurn(request, handlers) {
        seen.push(request.prompt);
        if (request.prompt === "active") {
          await new Promise<void>((_resolve, reject) => {
            handlers.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        return succeeded();
      },
    };
    const session = buildSession(agent);
    const running = session.submit("active");
    await vi.waitFor(() => expect(session.getState().running).toBe(true));
    session.enqueue("queued-a");
    session.enqueue("queued-b");
    session.sendQueuedNow(1);
    expect(session.queued()).toEqual(["queued-a", "queued-b"]);
    expect((await running).status).toBe("aborted");
    await vi.waitFor(() => {
      expect(seen).toEqual(["active", "queued-b", "queued-a"]);
      expect(session.queued()).toEqual([]);
    });
  });

  it("restores a promoted prompt when cancelAll wins the send-now race", async () => {
    const agent: AgentPort = {
      async runTurn(_request, handlers) {
        await new Promise<void>((_resolve, reject) => {
          handlers.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        return succeeded();
      },
    };
    const session = buildSession(agent);
    const running = session.submit("active");
    await vi.waitFor(() => expect(session.getState().running).toBe(true));
    session.enqueue("queued-a");
    session.enqueue("queued-b");
    session.sendQueuedNow(1);
    await session.cancelAll();
    expect((await running).status).toBe("aborted");
    expect(session.queued()).toEqual(["queued-a", "queued-b"]);
  });
});
