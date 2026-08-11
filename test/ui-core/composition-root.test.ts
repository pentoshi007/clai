import { describe, expect, it } from "vitest";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { ChatMessage } from "../../src/types.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";

class StubAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({ status: "succeeded", answer: "hi", steps: 1, remainingCriteria: [] });
    handlers.onEvent({ type: "turn-start", prompt: "go" });
    handlers.onEvent({ type: "assistant-message", text: "hi" });
    handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "hi", steps: 1 });
    handlers.onMessages?.([
      { role: "user", content: "go" },
      { role: "assistant", content: "hi" },
    ]);
    return outcome;
  }
}

class BurstAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({
      status: "succeeded",
      answer: "done",
      steps: 1,
      remainingCriteria: [],
    });
    handlers.onEvent({ type: "turn-start", prompt: "burst" });
    for (let index = 0; index < 2_100; index += 1) {
      handlers.onEvent({ type: "assistant-delta", text: String(index % 10) });
    }
    handlers.onEvent({ type: "assistant-message", text: "done" });
    handlers.onEvent({
      type: "turn-end",
      outcome,
      finalAnswer: "done",
      steps: 1,
    });
    handlers.onMessages?.([
      { role: "user", content: "burst" },
      { role: "assistant", content: "done" },
    ]);
    return outcome;
  }
}

function fakePersistence(): PersistencePort & { saved: ChatMessage[][] } {
  const saved: ChatMessage[][] = [];
  return {
    saved,
    async saveSession(messages) {
      saved.push([...messages]);
    },
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

const caps = detectCapabilities({
  env: { COLORTERM: "truecolor" },
  stdoutIsTTY: true,
  stdinIsTTY: true,
  columns: 120,
  rows: 40,
});

describe("createCompositionRoot", () => {
  it("assembles ports, controllers, registry, and capabilities from injected deps", () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
    });
    expect(services.ports.agent).toBeDefined();
    expect(services.commands.all().length).toBeGreaterThan(0);
    expect(services.router.resolve("enter", "composer")).toBe("editor.submit");
    expect(services.focus.activeContext()).toBe("composer");
    expect(services.capabilities.colorMode).toBe("truecolor");
    expect(services.recordedEvents).toHaveLength(0);
    services.dispose();
  });

  it("records emitted app events only when capture is enabled", async () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });
    const result = await services.session.submit("go");
    if (result.status === "error") throw result.error;
    expect(result.status).toBe("completed");
    expect(services.recordedEvents.length).toBeGreaterThan(0);
    // sequence is monotonic per session
    const seqs = services.recordedEvents.map((e) => e.sequence);
    expect([...seqs]).toEqual([...seqs].sort((a, b) => a - b));
    services.dispose();
  });

  it("forwards a supplied emit sink instead of recording", async () => {
    const seen: number[] = [];
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      emit: (e) => seen.push(e.sequence),
    });
    await services.session.submit("go");
    expect(seen.length).toBeGreaterThan(0);
    expect(services.recordedEvents).toHaveLength(0);
    services.dispose();
  });

  it("bounds explicit event capture during long streaming turns", async () => {
    const services = createCompositionRoot({
      agent: new BurstAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });

    await services.session.submit("burst");

    expect(services.recordedEvents).toHaveLength(2_000);
    expect(services.recordedEvents[0]?.sequence).toBeGreaterThan(1);
    expect(services.recordedEvents.at(-1)?.type).toBe("turn-ended");
    services.dispose();
  });

  it("persists the session on turn completion", async () => {
    const persistence = fakePersistence();
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence,
      capabilities: caps,
    });
    await services.session.submit("go");
    // Mid-turn autosave + end-of-turn persist may both write.
    expect(persistence.saved.length).toBeGreaterThanOrEqual(1);
    services.dispose();
  });

  it("dispose is idempotent", () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
    });
    services.dispose();
    expect(() => services.dispose()).not.toThrow();
  });
});
