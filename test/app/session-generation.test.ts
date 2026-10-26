import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import type { RunTurnHandlers } from "../../src/app/ports/agent-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { getProvider } from "../../src/llm/router.js";
import { footerMetrics } from "../../src/ui-core/rendering/footer-metrics.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";
import { tokensPerSecondLabel } from "../../src/ui-core/rendering/duration.js";
import { applyAppEvent } from "../../src/ui-core/state/transcript/apply-app-event.js";
import { EMPTY_TRANSCRIPT_STATE, transcriptItems } from "../../src/ui-core/state/transcript-types.js";

function rate(session: SessionController): string | undefined {
  const usage = { contextTokens: 0, contextLimit: 0, lastCompletionTokens: 0, sessionPromptTokens: 0, sessionCompletionTokens: 0, exact: true };
  return footerMetrics(usage, session.getState().generation, 120).rate;
}

const sessions: SessionController[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
});

function harness() {
  vi.spyOn(getProvider("free"), "listModels").mockResolvedValue([]);
  let handlers: RunTurnHandlers | undefined;
  let finish: (() => void) | undefined;
  const events: AnyAppEvent[] = [];
  const session = new SessionController({
    provider: "free",
    model: "fixture-model",
    noHistory: true,
    emit(event) { events.push(event); },
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
    summary() {
      return transcriptItems(events.reduce(applyAppEvent, EMPTY_TRANSCRIPT_STATE))
        .findLast((item) => item.kind === "turn-summary");
    },
  };
}

describe("session footer generation metrics", () => {
  const outcome = createTurnOutcome({ status: "succeeded", answer: "hi", steps: 2, remainingCriteria: [] });
  const ended: AgentEvent = { type: "turn-end", finalAnswer: "hi", steps: 2, outcome };

  it.each([
    ended, { type: "turn-aborted" }, { type: "turn-error", message: "failed" },
  ] satisfies AgentEvent[])("settles the footer to the same aggregate as the $type summary", async (terminal) => {
    const h = harness();
    const { turn, handlers } = await h.start();
    handlers.onEvent?.({ type: "turn-start", prompt: "hi" });
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 66, durationMs: 3_000 } });
    expect(rate(h.session)).toBe("22.0 tps");
    handlers.onEvent?.({ type: "status", text: "waiting for tool" });
    handlers.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 400, durationMs: 6_000, estimated: true } });
    expect(rate(h.session)).toBe("~66.7 tps");
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 500, durationMs: 7_000 } });
    expect(rate(h.session)).toBe("71.4 tps");
    handlers.onEvent?.(terminal);
    expect(rate(h.session)).toBe("56.6 tps");
    handlers.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 999, durationMs: 1_000, estimated: true } });
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 999, durationMs: 1_000 } });
    expect(rate(h.session)).toBe("56.6 tps");
    h.finish();
    await turn;
    expect(h.summary()?.generation).toEqual({ outputTokens: 566, durationMs: 10_000 });
    expect(tokensPerSecondLabel(h.summary()?.generation)).toBe("56.6 tok/s");
    expect(rate(h.session)).toBe("56.6 tps");
    expect(h.session.getState().generation).toEqual(h.summary()?.generation);
  });

  it("keeps the last measured rate through tools, unknown rounds, idle, and a new turn", async () => {
    const h = harness();
    const { turn, handlers } = await h.start();
    let updates = 0;
    h.session.subscribe(() => { updates += 1; });
    expect(rate(h.session)).toBeUndefined();
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 100, durationMs: 2_000 } });
    expect(rate(h.session)).toBe("50.0 tps");
    expect(updates).toBe(1);
    handlers.onEvent?.({ type: "generation-completed" });
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 0, durationMs: 1_000 } });
    handlers.onEvent?.({ type: "status", text: "waiting for tool" });
    expect(rate(h.session)).toBe("50.0 tps");
    expect(updates).toBe(1);
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 123, durationMs: 3_000 } });
    expect(updates).toBe(2);
    handlers.onEvent?.(ended);
    expect(h.summary()?.generation).toBeUndefined();
    expect(updates).toBe(2);
    h.finish();
    await turn;
    expect(rate(h.session)).toBe("41.0 tps");
    const next = await h.start();
    expect(rate(h.session)).toBe("41.0 tps");
    next.handlers.onEvent?.(ended);
    h.finish();
    await next.turn;
    expect(rate(h.session)).toBe("41.0 tps");
  });

  it("includes measured zero-token rounds and resets the aggregate on the next turn", async () => {
    const h = harness();
    const first = await h.start();
    first.handlers.onEvent?.({ type: "turn-start", prompt: "hi" });
    first.handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 66, durationMs: 3_000 } });
    first.handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 0, durationMs: 1_500 } });
    expect(rate(h.session)).toBe("22.0 tps");
    first.handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 500, durationMs: 5_500 } });
    first.handlers.onEvent?.(ended);
    h.finish();
    await first.turn;
    expect(rate(h.session)).toBe("56.6 tps");
    expect(h.session.getState().generation).toEqual(h.summary()?.generation);
    const next = await h.start();
    expect(rate(h.session)).toBe("56.6 tps");
    first.handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 999, durationMs: 1_000 } });
    first.handlers.onEvent?.(ended);
    expect(rate(h.session)).toBe("56.6 tps");
    next.handlers.onEvent?.({ type: "turn-start", prompt: "next" });
    next.handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 80, durationMs: 1_000 } });
    next.handlers.onEvent?.(ended);
    h.finish();
    await next.turn;
    expect(h.session.getState().generation).toEqual({ outputTokens: 80, durationMs: 1_000 });
    expect(h.session.getState().generation).toEqual(h.summary()?.generation);
  });

  it("updates during streaming, distinguishes estimates, and settles to exact provider usage", async () => {
    const h = harness();
    const { turn, handlers } = await h.start();
    const metrics = { outputTokens: 33, durationMs: 1_000, estimated: true as const };
    handlers.onEvent?.({ type: "generation-progress", metrics });
    expect(h.session.getState().running).toBe(true);
    expect(rate(h.session)).toBe("~33.0 tps");
    handlers.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 88, durationMs: 2_000, estimated: true } });
    expect(rate(h.session)).toBe("~44.0 tps");
    handlers.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 100, durationMs: 2_000 } });
    expect(rate(h.session)).toBe("50.0 tps");
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 120, durationMs: 2_000 } });
    h.finish();
    await turn;
    expect(rate(h.session)).toBe("60.0 tps");
  });

  it("does not republish identical readings or accept late callbacks from settled turns", async () => {
    const h = harness();
    const first = await h.start();
    const metrics = { outputTokens: 100, durationMs: 2_000 };
    first.handlers.onEvent?.({ type: "generation-completed", metrics });
    let updates = 0;
    h.session.subscribe(() => { updates += 1; });
    first.handlers.onEvent?.({ type: "generation-progress", metrics });
    first.handlers.onEvent?.({ type: "generation-completed", metrics });
    expect(updates).toBe(0);
    h.finish();
    await first.turn;
    const next = await h.start();
    first.handlers.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 999, durationMs: 1_000 } });
    first.handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 999, durationMs: 1_000 } });
    expect(rate(h.session)).toBe("50.0 tps");
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
    handlers.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 200, durationMs: 2_000, estimated: true } });
    handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 200, durationMs: 2_000 } });
    handlers.onEvent?.(ended);
    expect(h.session.getState().generation).toBeUndefined();
    h.finish();
    await turn;
    expect(h.session.getState().generation).toBeUndefined();
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
