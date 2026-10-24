import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import type { RunTurnHandlers } from "../../src/app/ports/agent-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { getProvider } from "../../src/llm/router.js";
import { tokensPerSecondLabel } from "../../src/ui-core/rendering/duration.js";

const sessions: SessionController[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
});

function harness() {
  vi.spyOn(getProvider("free"), "listModels").mockResolvedValue([]);
  let handlers: RunTurnHandlers | undefined;
  let finish: (() => void) | undefined;
  const session = new SessionController({
    provider: "free",
    model: "fixture-model",
    noHistory: true,
    emit() {},
    persistence: {
      async saveSession() {}, async loadPlan() { return undefined; },
      async savePlan() {}, async deletePlan() {},
    },
    agent: {
      async runTurn(_request, next) {
        handlers = next;
        await new Promise<void>((resolve) => { finish = resolve; });
        return createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
      },
    },
  });
  sessions.push(session);
  return {
    session,
    async start() {
      handlers = undefined;
      const turn = session.submit("measure generation");
      await expect.poll(() => handlers).toBeDefined();
      return { turn, handlers: handlers! };
    },
    finish() { finish?.(); },
  };
}

describe("session footer generation metrics", () => {
  it("publishes exact per-generation timing, invalidates unknown rounds, and retains the last measured rate at idle", async () => {
    const h = harness();
    const { turn, handlers } = await h.start();
    let updates = 0;
    h.session.subscribe(() => { updates += 1; });
    expect(h.session.getState().generation).toBeUndefined();
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 100, durationMs: 2_000 } });
    expect(tokensPerSecondLabel(h.session.getState().generation)).toBe("50.0 tok/s");
    expect(updates).toBe(1);
    handlers.onEvent?.({ type: "generation-completed" });
    expect(h.session.getState().generation).toBeUndefined();
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 123, durationMs: 3_000 } });
    expect(updates).toBe(3);
    h.finish();
    await turn;
    expect(tokensPerSecondLabel(h.session.getState().generation)).toBe("41.0 tok/s");
    const next = await h.start();
    expect(h.session.getState().generation).toBeUndefined();
    h.finish();
    await next.turn;
  });

  it.each(["provider", "model", "reset"] as const)("clears %s changes and fences metrics from an old route or lifecycle", async (change) => {
    const h = harness();
    const { turn, handlers } = await h.start();
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 100, durationMs: 2_000 } });
    expect(h.session.getState().generation).toBeDefined();
    if (change === "provider") h.session.setProvider("anthropic");
    if (change === "model") h.session.setModel("another-model");
    if (change === "reset") h.session.reset();
    expect(h.session.getState().generation).toBeUndefined();
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 200, durationMs: 2_000 } });
    expect(h.session.getState().generation).toBeUndefined();
    h.finish();
    await turn;
  });

  it.each([
    { outputTokens: -1, durationMs: 1_000 },
    { outputTokens: 100, durationMs: 0 },
    { outputTokens: 100, durationMs: Infinity },
  ])("does not publish invalid generation facts: %j", async (metrics) => {
    const h = harness();
    const { turn, handlers } = await h.start();
    handlers.onEvent?.({ type: "generation-completed", metrics });
    expect(h.session.getState().generation).toBeUndefined();
    h.finish();
    await turn;
  });
});
