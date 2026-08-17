import { describe, expect, it, vi } from "vitest";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";
import type { SuccessfulRequestSnapshot } from "../../src/types.js";

const succeeded = (): TurnOutcome =>
  createTurnOutcome({ status: "succeeded", answer: "", steps: 1, remainingCriteria: [] });

function primeCompactionSnapshot(session: SessionController): void {
  const snapshot: SuccessfulRequestSnapshot = {
    provider: "groq",
    model: "test-model",
    messages: [
      { role: "system", content: "main system prompt" },
      ...session.messages.slice(0, -1).map((message) => structuredClone(message)),
    ],
  };
  (
    session as unknown as {
      lastMainRequestSnapshot: SuccessfulRequestSnapshot | undefined;
    }
  ).lastMainRequestSnapshot = snapshot;
}

function fakePersistence(saved: string[][]): PersistencePort {
  return {
    async saveSession(messages) {
      saved.push(messages.map((message) => message.content));
    },
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

describe("session lifecycle generations (LIFE-004/005)", () => {
  it("ignores late turn callbacks after a reset", async () => {
    let emitLate: (() => void) | undefined;
    const agent: AgentPort = {
      async runTurn(_request: RunTurnRequest, handlers: RunTurnHandlers) {
        emitLate = () => {
          handlers.onSuccessfulRequest?.({
            provider: "groq",
            model: "test-model",
            messages: [{ role: "user", content: "old prompt" }],
          });
          handlers.onMessages?.([
            { role: "user", content: "old prompt" },
            { role: "assistant", content: "old answer" },
          ]);
        };
        return succeeded();
      },
    };
    const saved: string[][] = [];
    const session = new SessionController({
      agent,
      persistence: fakePersistence(saved),
      sessionId: "sess-generation",
      emit: () => {},
    });

    const running = session.submit("old prompt");
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.reset({ mintNewId: true });
    emitLate?.();
    await running;

    expect(session.messages).toHaveLength(0);
    expect(saved.flat()).not.toContain("old answer");
    await expect(session.compact()).rejects.toThrow(/no successful live model request/i);
  });

  it("does not commit a compaction that finishes after a history load", async () => {
    const agent: AgentPort = {
      async runTurn() {
        return succeeded();
      },
    };
    const saved: string[][] = [];
    const session = new SessionController({
      agent,
      persistence: fakePersistence(saved),
      sessionId: "sess-compact-generation",
      emit: () => {},
    });

    session.loadHistory([
      { role: "user", content: "session A question" },
      { role: "assistant", content: "session A answer" },
      { role: "user", content: "session A follow-up" },
      { role: "assistant", content: "session A second answer" },
    ]);

    primeCompactionSnapshot(session);
    const compacting = session.compact(undefined, 1);
    await new Promise((resolve) => setTimeout(resolve, 1));
    session.loadHistory([{ role: "user", content: "session B question" }], {
      sessionId: "sess-b",
    });
    await compacting.catch(() => undefined);

    expect(session.messages.map((message) => message.content)).toEqual([
      "session B question",
    ]);
    expect(session.getState().compacting).toBe(false);
  });

  it("aborts an in-flight compaction when the session is disposed", async () => {
    const agent: AgentPort = {
      async runTurn() {
        return succeeded();
      },
    };
    const session = new SessionController({
      agent,
      persistence: fakePersistence([]),
      sessionId: "sess-dispose",
      emit: () => {},
    });
    session.loadHistory([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);

    primeCompactionSnapshot(session);
    const compacting = session.compact(undefined, 1);
    session.dispose();
    await compacting.catch(() => undefined);
    expect(session.getState().compacting).toBe(false);
  });
});

vi.setConfig({ testTimeout: 15_000 });
