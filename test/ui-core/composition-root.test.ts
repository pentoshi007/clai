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
import { handleContext } from "../../src/ui-core/commands/session-commands.js";
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

class UsageAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({ status: "succeeded", answer: "usage", steps: 1, remainingCriteria: [] });
    handlers.onEvent({ type: "turn-start", prompt: "usage" });
    handlers.onEvent({
      type: "token-usage",
      provider: "openai",
      model: "gpt-test",
      usage: {
        promptTokens: 120,
        completionTokens: 20,
        totalTokens: 140,
        exact: true,
        cachedPromptTokens: 96,
        cacheCreationTokens: 4,
        uncachedPromptTokens: 20,
        reasoningTokens: 12,
      },
    });
    handlers.onEvent({ type: "assistant-message", text: "usage" });
    handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "usage", steps: 1 });
    handlers.onMessages?.([
      { role: "user", content: "usage" },
      { role: "assistant", content: "usage" },
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

  it("propagates cache and reasoning telemetry into the shared context inspection command", async () => {
    const services = createCompositionRoot({
      agent: new UsageAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });

    await services.session.submit("usage");

    expect(services.session.getState().contextSnapshot).toMatchObject({
      cache: {
        kind: "reported",
        readTokens: 96,
        creationTokens: 4,
        uncachedTokens: 20,
      },
      reasoning: { kind: "reported", outputTokens: 12 },
    });

    handleContext(services);
    const notice = services.recordedEvents.at(-1);
    expect(notice).toMatchObject({
      type: "notice",
      payload: {
        text: expect.stringContaining("cache read 96 / write 4 / uncached 20"),
      },
    });
    expect(
      notice?.type === "notice" ? notice.payload.text : "",
    ).toContain("reasoning output 12");
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
