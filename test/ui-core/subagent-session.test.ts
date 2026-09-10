import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import type { RunTurnHandlers } from "../../src/app/ports/agent-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import * as subagentStore from "../../src/store/subagents.js";
import type { SubagentStore } from "../../src/agent/subagents/types.js";
import { runReadOnlySubagent } from "../../src/agent/subagents/worker.js";

vi.mock("../../src/agent/subagents/worker.js", () => ({ runReadOnlySubagent: vi.fn() }));

const sessions: SessionController[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
});

function fixture(noHistory: boolean) {
  const requests: RunTurnHandlers[] = [];
  const session = new SessionController({
    sessionId: "parent-session",
    noHistory,
    provider: "openai",
    model: "test-model",
    emit: () => undefined,
    agent: {
      async runTurn(_request, handlers) {
        requests.push(handlers);
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
  return { session, requests };
}

function stubStore() {
  const store: SubagentStore = {
    load: vi.fn(() => []),
    save: vi.fn(),
    remove: vi.fn(),
  };
  const factory = vi.spyOn(subagentStore, "createSubagentStore").mockReturnValue(store);
  return { store, factory };
}

describe("session-owned orchestration", () => {
  it("cancelAll stops running children without disabling orchestration or changing completed reports", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(runReadOnlySubagent).mockImplementation(async ({ run, signal }) => {
      if (run.prompt === "completed") return "saved report";
      signals.push(signal);
      return new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      });
    });
    const { session } = fixture(true);
    session.subagents.setEnabled(true);
    const assignment = { title: "Inspect", prompt: "completed", cwd: process.cwd(), provider: "openai" as const, model: "test-model" };
    const completed = session.subagents.start(assignment);
    await session.subagents.wait(completed.id);
    const first = session.subagents.start({ ...assignment, prompt: "first" });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = session.subagents.start({ ...assignment, prompt: "second" });
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    const result = await session.cancelAll();

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Turn cancelled");
    expect(result.output).toContain("Requested stop for 2 subagent(s).");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await Promise.all([session.subagents.wait(first.id), session.subagents.wait(second.id)]);
    expect(session.subagents.get(first.id)?.status).toBe("stopped");
    expect(session.subagents.get(second.id)?.status).toBe("stopped");
    expect(session.subagents.get(completed.id)).toMatchObject({ status: "completed", report: "saved report" });
    expect(session.subagents.enabled).toBe(true);
    expect((await session.cancelAll()).output).not.toContain("Requested stop");
  });

  it("injects the same default-off manager into turn policy and keeps no-history memory-only", async () => {
    const { factory } = stubStore();
    const { session, requests } = fixture(true);
    expect(session.subagents.enabled).toBe(false);
    session.subagents.setEnabled(true);
    await session.submit("inspect the project");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.session?.subagents).toBe(session.subagents);
    expect(factory).not.toHaveBeenCalled();
  });

  it("reloads records by parent ID while defaulting restored orchestration off", () => {
    const { store, factory } = stubStore();
    const { session } = fixture(false);
    const previous = session.subagents;
    previous.setEnabled(true);
    const dispose = vi.spyOn(previous, "dispose");
    session.loadHistory([], { sessionId: "restored-parent" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(previous.enabled).toBe(false);
    expect(() => previous.setEnabled(true)).toThrow("disposed");
    expect(session.subagents).not.toBe(previous);
    expect(session.subagents.parentSessionId).toBe("restored-parent");
    expect(session.subagents.enabled).toBe(false);
    expect(store.load).toHaveBeenLastCalledWith("restored-parent");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("replaces and disables managers on reset (mintNewId=%s)", (mintNewId) => {
    const { session } = fixture(true);
    const previous = session.subagents;
    previous.setEnabled(true);
    session.reset({ mintNewId });
    expect(session.subagents).not.toBe(previous);
    expect(session.subagents.enabled).toBe(false);
    expect(previous.enabled).toBe(false);
    expect(session.subagents.parentSessionId).toBe(session.sessionId);
    expect(session.sessionId === previous.parentSessionId).toBe(!mintNewId);
    expect(() => previous.setEnabled(true)).toThrow("disposed");
  });

  it("disposes its manager on shutdown and restores without an explicit ID default-off", () => {
    const { session } = fixture(true);
    const previous = session.subagents;
    previous.setEnabled(true);
    session.loadHistory([]);
    expect(session.subagents).not.toBe(previous);
    expect(session.subagents.enabled).toBe(false);
    const manager = session.subagents;
    manager.setEnabled(true);
    session.dispose();
    expect(manager.enabled).toBe(false);
    expect(() => manager.setEnabled(true)).toThrow("disposed");
  });
});
