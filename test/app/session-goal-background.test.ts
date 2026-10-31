import { describe, expect, it } from "vitest";
import {
  GOAL_CHECK_IN_MS,
  GOAL_MAX_IDLE_CHECK_INS,
  SessionGoal,
  type GoalBackgroundWork,
  type GoalTimers,
} from "../../src/app/controllers/session-goal.js";
import type { GoalUpdate } from "../../src/app/controllers/goal-types.js";
import type { GoalVerdict } from "../../src/agent/goal/goal-verdict.js";
import type { TurnResult } from "../../src/app/controllers/turn-controller.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { asTurnId } from "../../src/app/events/app-event.js";

const completed: TurnResult = {
  status: "completed",
  turnId: asTurnId("t"),
  outcome: createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] }),
  finalAnswer: "ok",
};

function harness() {
  let now = 0;
  let background: GoalBackgroundWork = { running: [], pendingDeliveries: 0 };
  const timers: { at: number; callback: () => void }[] = [];
  const prompts: string[] = [];
  const updates: GoalUpdate[] = [];
  const verdicts: GoalVerdict[] = [];
  let evaluations = 0;
  const timerPort: GoalTimers = {
    set(callback, delayMs) {
      const entry = { at: now + delayMs, callback };
      timers.push(entry);
      return () => {
        const index = timers.indexOf(entry);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  };
  const goal: SessionGoal = new SessionGoal({
    now: () => now,
    mintId: () => "id",
    isBusy: () => false,
    hasQueuedWork: () => false,
    mode: () => "agent",
    background: () => background,
    tokens: () => 0,
    evaluate: async () => {
      evaluations += 1;
      return verdicts.shift();
    },
    runTurn: async (prompt) => {
      prompts.push(prompt);
      goal.noteTurnStarted();
      goal.noteToolCall();
      goal.handleTurnEnd(completed);
      goal.scheduleWake();
      return completed;
    },
    load: () => undefined,
    save: () => {},
    emit: (update) => updates.push(update),
    notifyState: () => {},
    idle: () => {},
    timers: timerPort,
  });
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  return {
    goal,
    prompts,
    updates,
    verdicts,
    timers,
    flush,
    evaluations: () => evaluations,
    setBackground: (value: GoalBackgroundWork) => { background = value; },
    advance: async (ms: number) => {
      now += ms;
      for (const entry of timers.filter((timer) => timer.at <= now)) {
        timers.splice(timers.indexOf(entry), 1);
        entry.callback();
      }
      await flush();
    },
  };
}

describe("goal background deferral", () => {
  it("skips evaluation while background work runs and evaluates once it finishes", async () => {
    const h = harness();
    h.setBackground({ running: ["background job npm test"], pendingDeliveries: 0 });
    h.goal.set("tests pass");
    await h.flush();
    expect(h.prompts).toHaveLength(1);
    expect(h.evaluations()).toBe(0);
    expect(h.goal.view()).toMatchObject({ phase: "waiting", waitingFor: ["background job npm test"] });
    expect(h.updates.map((update) => update.kind)).toEqual(["waiting"]);

    h.setBackground({ running: [], pendingDeliveries: 1 });
    h.goal.scheduleWake();
    await h.flush();
    expect(h.evaluations()).toBe(0);

    h.setBackground({ running: [], pendingDeliveries: 0 });
    h.verdicts.push({ kind: "met", reason: "green" });
    h.goal.scheduleWake();
    await h.flush();
    expect(h.evaluations()).toBe(1);
    expect(h.goal.view()).toBeUndefined();
  });

  it("checks in after 30 minutes with backoff and stops after the idle cap", async () => {
    const h = harness();
    h.setBackground({ running: ["subagent research"], pendingDeliveries: 0 });
    h.goal.set("research done");
    await h.flush();
    expect(h.timers.map((timer) => timer.at)).toEqual([GOAL_CHECK_IN_MS]);
    await h.advance(GOAL_CHECK_IN_MS);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain("Goal check-in");
    expect(h.prompts[1]).toContain("- subagent research");
    await h.advance(GOAL_CHECK_IN_MS * 2);
    await h.advance(GOAL_CHECK_IN_MS * 4);
    expect(h.prompts).toHaveLength(1 + GOAL_MAX_IDLE_CHECK_INS);
    expect(h.prompts.at(-1)).toContain("last automatic check-in");
    await h.advance(GOAL_CHECK_IN_MS * 4);
    expect(h.prompts).toHaveLength(1 + GOAL_MAX_IDLE_CHECK_INS);
    expect(h.timers).toHaveLength(0);
    expect(h.evaluations()).toBe(0);
  });
});
