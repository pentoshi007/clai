import { describe, expect, it } from "vitest";
import type { AgentPort } from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";
import { queueContinuationDecision } from "../../src/app/controllers/turn-continuation.js";
import { asTurnId } from "../../src/app/events/app-event.js";

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

const outcome = (
  status: TurnOutcome["status"],
  remaining: string[] = [],
): TurnOutcome =>
  createTurnOutcome({
    status,
    answer: "answer",
    steps: 2,
    remainingCriteria: remaining,
  });

describe("queue continuation predicate (LIFE-006)", () => {
  it("continues only for a genuinely successful turn", () => {
    const turnId = asTurnId("turn-1");
    expect(
      queueContinuationDecision({
        status: "completed",
        turnId,
        outcome: outcome("succeeded"),
        finalAnswer: "answer",
      }).proceed,
    ).toBe(true);
    for (const status of [
      "partial",
      "blocked",
      "failed",
      "aborted",
      "paused_budget",
    ] as const) {
      const decision = queueContinuationDecision({
        status: "completed",
        turnId,
        outcome: outcome(status, ["verify the fix"]),
        finalAnswer: "answer",
      });
      expect(decision.proceed).toBe(false);
      expect(decision.reason).toBeTruthy();
    }
    expect(queueContinuationDecision({ status: "aborted", turnId }).proceed).toBe(
      false,
    );
    expect(
      queueContinuationDecision({
        status: "error",
        turnId,
        error: new Error("boom"),
      }).proceed,
    ).toBe(false);
  });

  it("keeps queued prompts and notifies when a turn is blocked", async () => {
    const seen: string[] = [];
    const agent: AgentPort = {
      async runTurn(request) {
        seen.push(request.prompt);
        return createTurnOutcome({
          status: "blocked",
          answer: "needs credentials",
          steps: 1,
          remainingCriteria: ["obtain credentials"],
          reason: "missing credentials",
        });
      },
    };
    const notices: string[] = [];
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-continuation",
      emit: (event) => {
        if (event.type === "notice") notices.push(String(event.payload.text));
      },
    });

    await session.submit("first step");
    session.enqueue("second step");
    await session.continueQueue();

    expect(seen).toEqual(["first step"]);
    // The draft is kept for the user instead of running on a false prerequisite.
    expect(session.queued()).toEqual(["second step"]);
    await session.continueQueue();
    expect(seen).toEqual(["first step"]);
    expect(notices.join(" ")).toMatch(/paused/i);
  });
});

describe("loop guard auto-recovery", () => {
  const loopStopOutcome = (signature: string): TurnOutcome =>
    createTurnOutcome({
      status: "partial",
      answer: "stopped",
      steps: 3,
      remainingCriteria: ["continue with a different action"],
      reason: "repeated identical action sequence",
      loopGuardStop: {
        calls: 'fs.search {"pattern":"continueQueue"}',
        observation: "PRIOR-OUTPUT-BODY",
        signature,
      },
    });

  it("auto-recovers once with the captured output after a loop-guard stop", async () => {
    const prompts: string[] = [];
    let call = 0;
    const agent: AgentPort = {
      async runTurn(request) {
        prompts.push(request.prompt);
        call += 1;
        return call === 1 ? loopStopOutcome("sig-1") : outcome("succeeded");
      },
    };
    const notices: string[] = [];
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-loop-recovery",
      emit: (event) => {
        if (event.type === "notice") notices.push(String(event.payload.text));
      },
    });

    await session.submit("do work");
    await session.continueQueue();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("[LOOP GUARD RECOVERY]");
    expect(prompts[1]).toContain("PRIOR-OUTPUT-BODY");
    expect(prompts[1]).toContain("continueQueue");
    expect(notices.join(" ")).toMatch(/auto-recovering/i);
  });

  it("does not recover a normal completion", async () => {
    const prompts: string[] = [];
    const agent: AgentPort = {
      async runTurn(request) {
        prompts.push(request.prompt);
        return outcome("succeeded");
      },
    };
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-no-recovery",
      emit: () => {},
    });

    await session.submit("do work");
    await session.continueQueue();

    expect(prompts).toHaveLength(1);
  });

  it("blocks ultimately when the recovery turn loops on the same signature", async () => {
    const prompts: string[] = [];
    const agent: AgentPort = {
      async runTurn(request) {
        prompts.push(request.prompt);
        return loopStopOutcome("sig-1");
      },
    };
    const notices: string[] = [];
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-loop-block",
      emit: (event) => {
        if (event.type === "notice") notices.push(String(event.payload.text));
      },
    });

    await session.submit("do work");
    await session.continueQueue();
    await session.continueQueue();

    expect(prompts).toHaveLength(2);
    expect(notices.join(" ")).toMatch(/leaving the turn stopped/i);
  });

  it("drains a queued message after the recovery turn succeeds", async () => {
    const prompts: string[] = [];
    let call = 0;
    const agent: AgentPort = {
      async runTurn(request) {
        prompts.push(request.prompt);
        call += 1;
        return call === 1 ? loopStopOutcome("sig-1") : outcome("succeeded");
      },
    };
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-loop-drain",
      emit: () => {},
    });

    await session.submit("do work");
    session.enqueue("queued follow-up");
    await session.continueQueue();

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("[LOOP GUARD RECOVERY]");
    expect(prompts[2]).toBe("queued follow-up");
    expect(session.queued()).toEqual([]);
  });

  it("keeps the queued message paused when the recovery turn also loop-stops", async () => {
    const prompts: string[] = [];
    const agent: AgentPort = {
      async runTurn(request) {
        prompts.push(request.prompt);
        return loopStopOutcome("sig-1");
      },
    };
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-loop-drain-block",
      emit: () => {},
    });

    await session.submit("do work");
    session.enqueue("queued follow-up");
    await session.continueQueue();
    await session.continueQueue();

    expect(prompts).toHaveLength(2);
    expect(session.queued()).toEqual(["queued follow-up"]);
  });

  it("drain runs the recovery then the queued message when recovery succeeds", async () => {
    const prompts: string[] = [];
    let call = 0;
    const agent: AgentPort = {
      async runTurn(request) {
        prompts.push(request.prompt);
        call += 1;
        return call === 1 ? loopStopOutcome("sig-1") : outcome("succeeded");
      },
    };
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-loop-drain-headless",
      emit: () => {},
    });

    await session.submit("do work");
    session.enqueue("queued follow-up");
    await session.drain();

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("[LOOP GUARD RECOVERY]");
    expect(prompts[2]).toBe("queued follow-up");
    expect(session.queued()).toEqual([]);
  });

  it("drain keeps queued messages paused when the recovery turn loop-stops again", async () => {
    const prompts: string[] = [];
    const agent: AgentPort = {
      async runTurn(request) {
        prompts.push(request.prompt);
        return loopStopOutcome("sig-1");
      },
    };
    const notices: string[] = [];
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-loop-drain-headless-block",
      emit: (event) => {
        if (event.type === "notice") notices.push(String(event.payload.text));
      },
    });

    await session.submit("do work");
    session.enqueue("queued follow-up");
    await session.drain();

    expect(prompts).toHaveLength(2);
    expect(session.queued()).toEqual(["queued follow-up"]);
    expect(notices.join(" ")).toMatch(/paused/i);
  });
});
