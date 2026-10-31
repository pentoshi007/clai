import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort, RunTurnRequest } from "../../src/app/ports/agent-port.js";
import type { PersistedGoal, PersistencePort } from "../../src/app/ports/persistence-port.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";
import type { GoalUpdate } from "../../src/app/controllers/goal-types.js";
import type { GoalTimers } from "../../src/app/controllers/session-goal.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { ProviderError } from "../../src/llm/http.js";
import type { CompletionRequest } from "../../src/types.js";

const complete = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/llm/router.js")>(),
  completeWithProvider: (...args: unknown[]) => complete(...args),
}));
vi.mock("../../src/commands/providers.js", () => ({ ensureProviderConfigured: async () => {} }));
vi.mock("../../src/llm/catalog-prefetch.js", () => ({ prefetchProviderCatalog: async () => {} }));

type TurnScript = (request: RunTurnRequest, handlers: Parameters<AgentPort["runTurn"]>[1]) => Promise<void> | void;

interface Harness {
  readonly session: SessionController;
  readonly turns: RunTurnRequest[];
  readonly events: AnyAppEvent[];
  readonly updates: () => GoalUpdate[];
  readonly store: Map<string, PersistedGoal>;
  readonly timers: FakeTimers;
}

class FakeTimers implements GoalTimers {
  readonly pending: { callback: () => void; delayMs: number }[] = [];
  now = 1_000_000;
  set(callback: () => void, delayMs: number): () => void {
    const entry = { callback, delayMs };
    this.pending.push(entry);
    return () => {
      const index = this.pending.indexOf(entry);
      if (index >= 0) this.pending.splice(index, 1);
    };
  }
  fire(): void {
    const next = this.pending.shift();
    if (!next) return;
    this.now += next.delayMs;
    next.callback();
  }
}

let harness: Harness | undefined;

function verdicts(...texts: string[]): void {
  for (const text of texts) {
    complete.mockImplementationOnce(async (request: CompletionRequest) => ({
      provider: request.provider ?? "openai",
      model: request.model ?? "gpt-5",
      text,
      finishReason: "stop",
    }));
  }
}

const verdict = (kind: string, reason: string, nextStep?: string): string =>
  JSON.stringify({ verdict: kind, reason, ...(nextStep ? { next_step: nextStep } : {}) });

function build(script: TurnScript = () => {}, options: { sessionId?: string; store?: Map<string, PersistedGoal> } = {}): Harness {
  const turns: RunTurnRequest[] = [];
  const events: AnyAppEvent[] = [];
  const store = options.store ?? new Map<string, PersistedGoal>();
  const timers = new FakeTimers();
  const persistence: PersistencePort = {
    async saveSession() {},
    async loadPlan() { return undefined; },
    async savePlan() {},
    async deletePlan() {},
    loadGoal: (sessionId) => store.get(sessionId),
    saveGoal: (sessionId, goal) => {
      if (goal) store.set(sessionId, goal);
      else store.delete(sessionId);
    },
  };
  const agent: AgentPort = {
    async runTurn(request, handlers) {
      turns.push(request);
      await script(request, handlers);
      return createTurnOutcome({ status: "succeeded", answer: "done", steps: 1, remainingCriteria: [] });
    },
  };
  const session = new SessionController({
    agent,
    persistence,
    provider: "openai",
    model: "gpt-5",
    mode: "agent",
    sessionId: options.sessionId ?? "goal-session",
    emit: (event) => events.push(event),
    goalTimers: timers,
    clock: { now: () => timers.now },
    titleCompleter: async () => "TITLE: goal",
  });
  harness = {
    session,
    turns,
    events,
    store,
    timers,
    updates: () => events.flatMap((event) => event.type === "goal-updated" ? [event.payload] : []),
  };
  return harness;
}

async function settle(session: SessionController): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = session.getState();
    if (!state.running && state.goal?.phase !== "evaluating" && state.queued.length === 0 && round > 5) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const again = session.getState();
      if (!again.running && again.goal?.phase !== "evaluating") return;
    }
  }
}

const useTool: TurnScript = (_request, handlers) => {
  handlers.onEvent({ type: "tool-call", id: `call-${Math.random()}`, name: "shell.exec", argsDisplay: "npm test" });
};

beforeEach(() => {
  complete.mockReset();
});

afterEach(() => {
  harness?.session.dispose();
  harness = undefined;
});

describe("/goal session loop", () => {
  it("kicks off with the condition, evaluates after the turn and records an achieved goal", async () => {
    const { session, turns, updates } = build(useTool);
    verdicts(verdict("met", "npm test exited 0"));
    const result = session.setGoal("all tests pass");
    expect(result).toEqual({ ok: true, objective: "all tests pass", deferred: false });
    await settle(session);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("<goal_condition>\nall tests pass\n</goal_condition>");
    expect(turns[0]!.displayPrompt).toBe("/goal all tests pass");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(session.getState().goal).toBeUndefined();
    expect(updates().map((update) => update.kind)).toEqual(["achieved"]);
    expect(session.goalReport()).toMatchObject({ status: "achieved", objective: "all tests pass", turns: 1, lastReason: "npm test exited 0" });
  });

  it("continues with the evaluator reason as a hidden prompt until the condition holds", async () => {
    const { session, turns, updates } = build(useTool);
    verdicts(verdict("not_met", "lint fails in a.ts", "fix the lint error"), verdict("met", "lint is clean"));
    session.setGoal("lint is clean");
    await settle(session);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.displayPrompt).toBeNull();
    expect(turns[1]!.prompt).toContain("Evaluator reason: lint fails in a.ts");
    expect(turns[1]!.prompt).toContain("Suggested next step: fix the lint error");
    expect(updates().map((update) => update.kind)).toEqual(["continuing", "achieved"]);
  });

  it("clears the goal with a failed entry when the evaluator judges it impossible", async () => {
    const { session, updates } = build(useTool);
    verdicts(verdict("impossible", "the requested API does not exist"));
    session.setGoal("use the v9 API");
    await settle(session);
    expect(session.getState().goal).toBeUndefined();
    expect(session.goalReport()).toBeUndefined();
    expect(updates()).toEqual([expect.objectContaining({ kind: "failed", reason: "the requested API does not exist" })]);
  });

  it("pauses after three turns without tool calls and resumes on the next user prompt", async () => {
    const { session, turns, updates } = build();
    verdicts(verdict("not_met", "nothing changed"), verdict("not_met", "nothing changed"), verdict("not_met", "nothing changed"));
    session.setGoal("ship it");
    await settle(session);
    expect(turns).toHaveLength(3);
    expect(session.getState().goal).toMatchObject({ status: "paused", resumeOnPrompt: true });
    expect(updates().at(-1)).toMatchObject({ kind: "paused", resumeOnPrompt: true });
    expect(updates().at(-1)!.reason).toContain("no progress");

    verdicts(verdict("met", "shipped"));
    await session.submit("try a different approach");
    await settle(session);
    expect(turns).toHaveLength(4);
    expect(updates().map((update) => update.kind).slice(-2)).toEqual(["resumed", "achieved"]);
  });

  it("pauses when the user interrupts a goal turn", async () => {
    let release: (() => void) | undefined;
    const { session } = build(async (_request, handlers) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        handlers.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      handlers.signal?.throwIfAborted();
    });
    session.setGoal("long task");
    await vi.waitFor(() => expect(session.getState().running).toBe(true));
    session.abort();
    await settle(session);
    release?.();
    expect(complete).not.toHaveBeenCalled();
    expect(session.getState().goal).toMatchObject({ status: "paused", pauseReason: "interrupted", resumeOnPrompt: true });
  });

  it("interrupts an in-flight evaluation without running another turn", async () => {
    const { session, turns } = build(useTool);
    complete.mockImplementationOnce((request: CompletionRequest) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }));
    session.setGoal("tests pass");
    await vi.waitFor(() => expect(session.getState().goal?.phase).toBe("evaluating"));
    session.abort();
    await settle(session);
    expect(turns).toHaveLength(1);
    expect(session.getState().goal).toMatchObject({ status: "paused", pauseReason: "interrupted" });
  });

  it("clears the goal after an unrecoverable turn error", async () => {
    const { session, updates } = build(() => {
      throw new ProviderError("unauthorized: invalid api key", 401);
    });
    session.setGoal("deploy");
    await settle(session);
    expect(session.getState().goal).toBeUndefined();
    expect(updates()).toEqual([expect.objectContaining({ kind: "unrecoverable" })]);
  });

  it("retries transient failures with backoff, then pauses", async () => {
    const { session, turns, timers, updates } = build(() => {
      throw new ProviderError("upstream overloaded", 503);
    });
    session.setGoal("deploy");
    await settle(session);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(session.getState().goal?.phase).toBe("retrying");
      expect(timers.pending).toHaveLength(1);
      timers.fire();
      await settle(session);
    }
    expect(turns).toHaveLength(4);
    expect(turns[1]!.prompt).toContain("The previous turn failed before it finished");
    expect(updates().filter((update) => update.kind === "retrying").map((update) => update.delayMs)).toEqual([15_000, 30_000, 60_000]);
    expect(session.getState().goal).toMatchObject({ status: "paused" });
  });

  it("pauses on rate limits instead of retrying", async () => {
    const { session, timers } = build(() => {
      throw new ProviderError("rate limit exceeded", 429);
    });
    session.setGoal("deploy");
    await settle(session);
    expect(timers.pending).toHaveLength(0);
    expect(session.getState().goal).toMatchObject({ status: "paused", resumeOnPrompt: true });
  });

  it("defers evaluation in plan mode and evaluates after leaving it", async () => {
    const { session } = build(useTool);
    session.setMode("plan");
    session.setGoal("design approved");
    await settle(session);
    expect(complete).not.toHaveBeenCalled();
    expect(session.getState().goal).toMatchObject({ status: "active", phase: "waiting" });
    verdicts(verdict("met", "done"));
    session.setMode("agent");
    await settle(session);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(session.getState().goal).toBeUndefined();
  });

  it("queues the kickoff behind a running turn", async () => {
    let release: (() => void) | undefined;
    let first = true;
    const { session, turns } = build(async (request, handlers) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      useTool(request, handlers);
    });
    const running = session.submit("existing work");
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(session.setGoal("finish")).toMatchObject({ ok: true, deferred: true });
    verdicts(verdict("met", "finished"));
    release?.();
    await running;
    await settle(session);
    expect(turns.map((turn) => turn.displayPrompt ?? turn.prompt)).toEqual(["existing work", "/goal finish"]);
    expect(session.getState().goal).toBeUndefined();
  });

  it("pauses a pending kickoff when the user interrupts the current turn", async () => {
    const { session, turns } = build(async (_request, handlers) => {
      await new Promise<void>((resolve) => handlers.signal?.addEventListener("abort", () => resolve(), { once: true }));
      handlers.signal?.throwIfAborted();
    });
    const running = session.submit("existing work");
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    session.setGoal("finish");
    session.abort();
    await running;
    await settle(session);
    expect(turns).toHaveLength(1);
    expect(session.getState().goal).toMatchObject({ status: "paused", pauseReason: "interrupted", resumeOnPrompt: true });
  });

  it("pauses, resumes and clears through the session API", async () => {
    const { session, store, updates } = build(useTool);
    verdicts(verdict("not_met", "pending", "continue"));
    complete.mockImplementation(async () => ({ provider: "openai", model: "gpt-5", text: verdict("not_met", "pending"), finishReason: "stop" }));
    session.setGoal("x");
    session.pauseGoal();
    await settle(session);
    expect(session.getState().goal).toMatchObject({ status: "paused", resumeOnPrompt: false });
    expect(store.get("goal-session")).toMatchObject({ status: "paused", pause: { resumeOnPrompt: false } });
    session.enqueue("unrelated");
    await settle(session);
    expect(session.getState().goal?.status).toBe("paused");
    expect(session.clearGoal()).toBe("x");
    expect(session.clearGoal()).toBeUndefined();
    expect(store.has("goal-session")).toBe(false);
    expect(updates().map((update) => update.kind)).toEqual(["paused", "cleared"]);
  });

  it("rejects empty and over-long conditions and replaces an existing goal", () => {
    const { session, updates } = build(useTool);
    session.setMode("plan");
    expect(session.setGoal("  ")).toEqual({ ok: false, error: "Usage: /goal <condition>" });
    expect(session.setGoal("x".repeat(4001))).toMatchObject({ ok: false });
    session.setGoal("first");
    expect(session.setGoal("second")).toMatchObject({ ok: true, replaced: "first" });
    expect(updates()).toEqual([expect.objectContaining({ kind: "replaced", objective: "first" })]);
  });

  it("restores an active goal on resume with counters reset and no automatic turn", async () => {
    const store = new Map<string, PersistedGoal>([
      ["restored", { id: "g1", objective: "restored goal", status: "active", createdAt: 1 }],
    ]);
    const { session, turns } = build(useTool, { sessionId: "other", store });
    session.loadHistory([{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }], { sessionId: "restored" });
    await settle(session);
    expect(turns).toHaveLength(0);
    expect(session.getState().goal).toMatchObject({ objective: "restored goal", status: "active", turns: 0 });
    verdicts(verdict("met", "done"));
    await session.submit("continue");
    await settle(session);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(store.has("restored")).toBe(false);
  });

  it("removes the goal on reset", async () => {
    const { session } = build(useTool);
    session.setMode("plan");
    session.setGoal("x");
    session.reset({ mintNewId: true });
    expect(session.getState().goal).toBeUndefined();
    expect(session.goalReport()).toBeUndefined();
  });
});
