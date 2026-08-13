import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ChatMessage } from "../../src/types.js";
import type { SessionPlan } from "../../src/store/plan.js";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";
import { asSessionId, asToolCallId, asTurnId } from "../../src/app/events/app-event.js";
import { OutputSpool } from "../../src/app/events/event-buffer.js";
import {
  createCountingIdFactory,
  EventSequencer,
} from "../../src/app/events/sequencer.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { TurnController } from "../../src/app/controllers/turn-controller.js";
import { PlanController } from "../../src/app/controllers/plan-controller.js";
import { CompositeDisposable } from "../../src/app/controllers/disposable.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";

const plan: SessionPlan = {
  sessionId: "sess-contract",
  goal: "do the thing",
  detail: "detail",
  tasks: [{ id: "t1", title: "one", state: "pending" }],
  status: "draft",
  kind: "general",
  createdAt: "t",
  updatedAt: "t",
};

/** Fake agent: replays a scripted event list, then hands back turn messages. */
class ScriptedAgentPort implements AgentPort {
  constructor(
    private readonly events: AgentEvent[],
    private readonly finalAnswer: string,
    private readonly turnMessages: ChatMessage[],
  ) {}

  async runTurn(
    _request: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    for (const event of this.events) handlers.onEvent(event);
    handlers.onMessages?.(this.turnMessages);
    return createTurnOutcome({
      status: "succeeded",
      answer: this.finalAnswer,
      steps: 1,
      remainingCriteria: [],
    });
  }
}

function fakePersistence(): PersistencePort & {
  saved: ChatMessage[][];
} {
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

const scriptedEvents: AgentEvent[] = [
  { type: "turn-start", prompt: "go" },
  { type: "status", text: "step 1" },
  { type: "thinking-delta", text: "hmm" },
  { type: "assistant-delta", text: "Hel" },
  { type: "assistant-delta", text: "lo" },
  { type: "tool-call", id: "c1", name: "fs.read", argsDisplay: "a.ts" },
  { type: "tool-output", id: "c1", chunk: "file data" },
  { type: "tool-result", id: "c1", ok: true, summary: "read", exitCode: 0 },
  { type: "plan-update", plan },
  { type: "assistant-message", text: "Done" },
  {
    type: "turn-end",
    outcome: createTurnOutcome({ status: "succeeded", answer: "Done", steps: 1, remainingCriteria: [] }),
    finalAnswer: "Done",
    steps: 1,
  },
];

const turnMessages: ChatMessage[] = [
  { role: "user", content: "go" },
  { role: "assistant", content: "Done" },
];

function buildSession(prefix = "") {
  const events: AnyAppEvent[] = [];
  const persistence = fakePersistence();
  const plans = new PlanController(persistence);
  const agent = new ScriptedAgentPort(scriptedEvents, "Done", turnMessages);
  const session = new SessionController({
    agent,
    persistence,
    sessionId: "sess-contract",
    emit: (event) => {
      events.push(event);
      plans.observe(event);
    },
    idFactory: createCountingIdFactory(prefix),
    clock: { now: () => 1_700_000_000_000 },
    mintTurnId: (() => {
      let n = 0;
      return () => `turn-${(n += 1)}` as never;
    })(),
  });
  return { events, persistence, plans, session };
}

describe("V2-025 controllers run a complete scripted turn (Phase 2 gate)", () => {
  it("emits ordered AppEvents, streams deltas, references tool output, updates plan + history", async () => {
    const { events, persistence, plans, session } = buildSession();
    const result = await session.submit("go");

    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.finalAnswer).toBe("Done");

    // Visible chunks are dispatched as they arrive; the transcript reducer
    // renders them in a single streaming response row.
    expect(events.map((e) => e.type)).toEqual([
      "turn-started",
      "status",
      "thinking-delta",
      "assistant-delta",
      "assistant-delta",
      "tool-call",
      "tool-output",
      "tool-result",
      "plan-updated",
      "assistant-message",
      "turn-ended",
    ]);
    const assistantDeltas = events.filter((e) => e.type === "assistant-delta");
    expect(assistantDeltas.map((event) => event.payload)).toEqual([
      { text: "Hel" },
      { text: "lo" },
    ]);

    // Monotonic, gap-free sequence; every event carries the turn id.
    expect(events.map((e) => e.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(events.every((e) => e.turnId === "turn-1")).toBe(true);

    // Tool output is referenced through the spool, not inlined in the event.
    const output = events.find((e) => e.type === "tool-output");
    expect(output?.payload).toEqual({
      ref: { toolCallId: "turn-1:c1", chunkBytes: 9, totalBytes: 9 },
    });
    expect(session.spool.tail(asToolCallId("turn-1:c1"))).toBe("file data");

    // Plan controller tracked the plan; history + persistence updated.
    expect(plans.current()?.goal).toBe("do the thing");
    expect(session.getState().historyLength).toBe(2);
    expect(session.getState().running).toBe(false);
    // Mid-turn autosave + end-of-turn persist may both write; last wins.
    expect(persistence.saved.length).toBeGreaterThanOrEqual(1);
    expect(persistence.saved[persistence.saved.length - 1]).toEqual(
      turnMessages,
    );
  });

  it("produces byte-identical events on replay with deterministic ids + clock", async () => {
    const a = buildSession("run-");
    await a.session.submit("go");
    const b = buildSession("run-");
    await b.session.submit("go");
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
  });
});

describe("TurnController live tool output", () => {
  it("collapses a synchronous output flood before reducing transcript events", async () => {
    const chunks = 20_000;
    const events: AnyAppEvent[] = [];
    const spool = new OutputSpool();
    const agent: AgentPort = {
      async runTurn(_request, handlers) {
        handlers.onEvent({ type: "tool-call", id: "flood", name: "shell.exec", argsDisplay: "yes" });
        handlers.onEvent({ type: "tool-start", id: "flood" });
        for (let index = 0; index < chunks; index += 1) {
          handlers.onEvent({ type: "tool-output", id: "flood", chunk: "x" });
        }
        handlers.onEvent({ type: "tool-result", id: "flood", ok: true, summary: "done", exitCode: 0 });
        return createTurnOutcome({
          status: "succeeded",
          answer: "done",
          steps: 1,
          remainingCriteria: [],
        });
      },
    };
    const controller = new TurnController({
      agent,
      sequencer: new EventSequencer(
        asSessionId("tool-output-flood"),
        createCountingIdFactory("flood-"),
      ),
      spool,
      emit: (event) => events.push(event),
      mintTurnId: () => asTurnId("flood-turn"),
    });

    const result = await controller.run({ prompt: "run", mode: "agent" });
    const outputEvents = events.filter((event) => event.type === "tool-output");

    expect(result.status).toBe("completed");
    expect(outputEvents).toHaveLength(1);
    expect(outputEvents[0]?.payload).toEqual({
      ref: {
        toolCallId: "flood-turn:flood",
        chunkBytes: chunks,
        totalBytes: chunks,
      },
    });
    expect(spool.tail(asToolCallId("flood-turn:flood"))).toBe("x".repeat(chunks));
    expect(events.map((event) => event.type)).toEqual([
      "tool-call",
      "tool-started",
      "tool-output",
      "tool-result",
    ]);
    controller.dispose();
  });

  it("keeps replacement output authoritative while batching later chunks", async () => {
    const events: AnyAppEvent[] = [];
    const spool = new OutputSpool();
    const agent: AgentPort = {
      async runTurn(_request, handlers) {
        handlers.onEvent({ type: "tool-call", id: "replace", name: "shell.exec", argsDisplay: "printf" });
        handlers.onEvent({ type: "tool-output", id: "replace", chunk: "stale" });
        handlers.onEvent({ type: "tool-output", id: "replace", chunk: "final", replace: true });
        handlers.onEvent({ type: "tool-output", id: "replace", chunk: " body" });
        handlers.onEvent({ type: "tool-result", id: "replace", ok: true, summary: "done", exitCode: 0 });
        return createTurnOutcome({
          status: "succeeded",
          answer: "done",
          steps: 1,
          remainingCriteria: [],
        });
      },
    };
    const controller = new TurnController({
      agent,
      sequencer: new EventSequencer(
        asSessionId("tool-output-replace"),
        createCountingIdFactory("replace-"),
      ),
      spool,
      emit: (event) => events.push(event),
      mintTurnId: () => asTurnId("replace-turn"),
    });

    await controller.run({ prompt: "run", mode: "agent" });

    expect(events.filter((event) => event.type === "tool-output")).toHaveLength(1);
    expect(spool.tail(asToolCallId("replace-turn:replace"))).toBe("final body");
    controller.dispose();
  });
});

describe("PlanController session projection lifecycle", () => {
  it("clears synchronously and ignores a stale load after clear", async () => {
    let resolveSlow: ((value: SessionPlan | undefined) => void) | undefined;
    const slow = new Promise<SessionPlan | undefined>((resolve) => {
      resolveSlow = resolve;
    });
    const persistence: PersistencePort = {
      async saveSession() {},
      async loadPlan(sessionId) {
        if (sessionId === "seed") return plan;
        return slow;
      },
      async savePlan() {},
      async deletePlan() {},
    };
    const controller = new PlanController(persistence);
    await controller.load("seed");
    expect(controller.current()).toBe(plan);

    const pending = controller.load("old-session");
    expect(controller.current()).toBeUndefined();
    controller.clear();
    resolveSlow?.(plan);
    await pending;

    expect(controller.current()).toBeUndefined();
  });

  it("lets a newer session load win over an older unresolved load", async () => {
    let resolveOld: ((value: SessionPlan | undefined) => void) | undefined;
    const old = new Promise<SessionPlan | undefined>((resolve) => {
      resolveOld = resolve;
    });
    const persistence: PersistencePort = {
      async saveSession() {},
      async loadPlan(sessionId) {
        return sessionId === "old" ? old : undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    };
    const controller = new PlanController(persistence);
    const stale = controller.load("old");
    await controller.load("new");
    resolveOld?.(plan);
    await stale;

    expect(controller.current()).toBeUndefined();
  });
});

describe("V2-025 abort is a distinct result from error", () => {
  class SignalAgent implements AgentPort {
    runTurn(request: RunTurnRequest, handlers: RunTurnHandlers): Promise<TurnOutcome> {
      handlers.onEvent({ type: "turn-start", prompt: request.prompt });
      return new Promise<TurnOutcome>((_resolve, reject) => {
        const signal = handlers.signal;
        const fail = () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (!signal) return;
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    }
  }

  class ThrowingAgent implements AgentPort {
    async runTurn(): Promise<TurnOutcome> {
      throw new Error("boom");
    }
  }

  it("returns status 'aborted' when the turn is aborted", async () => {
    const session = new SessionController({
      agent: new SignalAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    const pending = session.submit("go");
    await Promise.resolve();
    session.abort();
    const result = await pending;
    expect(result.status).toBe("aborted");
    session.dispose();
  });

  it("returns status 'error' when the turn throws", async () => {
    const persistence = fakePersistence();
    const session = new SessionController({
      agent: new ThrowingAgent(),
      persistence,
      emit: () => {},
    });
    const result = await session.submit("go");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.message).toBe("boom");
    // A failed turn is never persisted.
    expect(persistence.saved).toHaveLength(0);
  });
});

describe("V2-025 disposal is idempotent and reverse-ordered", () => {
  it("disposes composite members in reverse creation order once", () => {
    const order: number[] = [];
    const composite = new CompositeDisposable();
    composite.add({ dispose: () => order.push(1) });
    composite.add({ dispose: () => order.push(2) });
    composite.add({ dispose: () => order.push(3) });
    composite.dispose();
    composite.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it("session dispose is safe to call twice and stops the turn controller", () => {
    const session = new SessionController({
      agent: new ScriptedAgentPort([], "x", []),
      persistence: fakePersistence(),
      emit: () => {},
    });
    session.dispose();
    session.dispose();
    expect(session.getState().running).toBe(false);
  });

  it("rejects submit after dispose (turn controller disposed)", async () => {
    const session = new SessionController({
      agent: new ScriptedAgentPort(scriptedEvents, "Done", turnMessages),
      persistence: fakePersistence(),
      emit: () => {},
    });
    session.dispose();
    await expect(session.submit("go")).rejects.toThrow(/disposed/);
  });
});


describe("TurnController acceptance boundary", () => {
  it("does not start the agent when onStarted rejects delivery", async () => {
    const runTurn = vi.fn(async () =>
      createTurnOutcome({
        status: "succeeded",
        answer: "unexpected",
        steps: 1,
        remainingCriteria: [],
      }),
    );
    const controller = new TurnController({
      agent: { runTurn },
      sequencer: new EventSequencer(
        asSessionId("acceptance-boundary"),
        createCountingIdFactory("accept-"),
        { now: () => 1_700_000_000_000 },
      ),
      spool: new OutputSpool(),
      emit: () => undefined,
    });

    const result = await controller.run(
      { prompt: "hidden responder turn", mode: "agent" },
      {
        onStarted: () => {
          throw new Error("deliveredAt persistence failed");
        },
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: { message: "deliveredAt persistence failed" },
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(controller.running).toBe(false);
    controller.dispose();
  });
});
