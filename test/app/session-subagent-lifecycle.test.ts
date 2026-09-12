import { afterEach, describe, expect, it } from "vitest";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { createSubagentStore } from "../../src/store/subagents.js";
import type { SubagentManager } from "../../src/agent/subagents/manager.js";

const sessions: SessionController[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function setup(sessionId: string) {
  const seen: (SubagentManager | undefined)[] = [];
  const session = new SessionController({
    sessionId,
    provider: "openai",
    model: "test-model",
    emit: () => undefined,
    agent: {
      async runTurn(_request, handlers) {
        seen.push(handlers.session?.subagents);
        return createTurnOutcome({ status: "succeeded", answer: "done", steps: 0, remainingCriteria: [] });
      },
    },
    persistence: {
      async saveSession() {},
      async loadPlan() { return undefined; },
      async savePlan() {},
      async deletePlan() {},
    },
  });
  sessions.push(session);
  return { session, seen };
}

describe("production session subagent lifecycle", () => {
  it("hydrates synchronously and preserves immediate enablement across later turns", async () => {
    const parentSessionId = "hydrated-subagent-session";
    createSubagentStore().save({
      id: "restored-child", parentSessionId, title: "Saved research", prompt: "Inspect saved evidence",
      cwd: process.cwd(), provider: "openai", model: "test-model", attempt: 1,
      status: "completed", report: "Saved evidence", recovery: "history", createdAt: 1, updatedAt: 1, events: [],
    });
    const { session, seen } = setup(parentSessionId);
    const manager = session.subagents;
    expect(manager.get("restored-child")?.report).toBe("Saved evidence");
    expect(manager.enabled).toBe(false);
    session.setOrchestrationEnabled(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.submit("Explain the saved evidence");
    await session.submit("Follow up without changing the session");
    expect(session.subagents).toBe(manager);
    expect(manager.enabled).toBe(true);
    expect(seen).toEqual([manager, manager]);
  });

  it("replaces the manager only at explicit history-load and reset boundaries", async () => {
    const { session, seen } = setup("subagent-session-before-restore");
    const previous = session.subagents;
    session.setOrchestrationEnabled(true);
    session.loadHistory([], { sessionId: "subagent-session-after-restore" });
    const restored = session.subagents;
    expect(restored).not.toBe(previous);
    expect(previous.enabled).toBe(false);
    expect(restored.enabled).toBe(false);
    expect(restored.parentSessionId).toBe("subagent-session-after-restore");
    session.setOrchestrationEnabled(true);
    await session.submit("Continue this restored session");
    expect(restored.enabled).toBe(true);
    expect(seen).toEqual([restored]);
    session.reset();
    expect(session.subagents).not.toBe(restored);
    expect(restored.enabled).toBe(false);
    expect(session.subagents.enabled).toBe(false);
  });
});
