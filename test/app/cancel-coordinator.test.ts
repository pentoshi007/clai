import { describe, expect, it } from "vitest";
import { CancelCoordinator } from "../../src/app/controllers/cancel-coordinator.js";

interface FakeOptions {
  readonly running?: boolean;
  readonly compacting?: boolean;
  readonly queued?: readonly string[];
  readonly runningJobs?: number;
  readonly pendingNotifications?: number;
  readonly interruptibleWork?: boolean;
  readonly cancelAllOk?: boolean;
}

function build(options: FakeOptions = {}) {
  const calls: string[] = [];
  const sessionIds: string[] = [];
  let running = options.running === true;
  let interruptible = options.interruptibleWork === true;
  const coordinator = new CancelCoordinator({
    session: {
      getState: () => ({
        running,
        compacting: options.compacting === true,
        queued: options.queued ?? [],
      }),
      abort: () => {
        calls.push("session.abort");
        running = false;
      },
      cancelAll: async () => {
        calls.push("session.cancelAll");
        running = false;
        return { ok: options.cancelAllOk !== false, output: "" };
      },
    },
    sessionId: () => "s1",
    jobs: {
      running: (sessionId) => {
        sessionIds.push(sessionId);
        return Array.from({ length: options.runningJobs ?? 0 });
      },
      pendingNotifications: (sessionId) => {
        sessionIds.push(sessionId);
        return Array.from({ length: options.pendingNotifications ?? 0 });
      },
    },
    interruptible: {
      hasWork: () => interruptible,
      cancelAll: () => {
        const count = interruptible ? 1 : 0;
        interruptible = false;
        calls.push(`interruptible.cancelAll:${count}`);
        return count;
      },
    },
  });
  return { coordinator, calls, sessionIds };
}

describe("CancelCoordinator", () => {
  it("snapshots every cancelable work class", () => {
    const { coordinator, sessionIds } = build({
      running: true,
      compacting: true,
      queued: ["a", "b"],
      runningJobs: 2,
      pendingNotifications: 1,
      interruptibleWork: true,
    });
    expect(coordinator.snapshot()).toEqual({
      turn: true,
      compaction: true,
      queuedPrompts: 2,
      responderJobs: 2,
      pendingNotifications: 1,
      interruptible: true,
    });
    expect(sessionIds).toEqual(["s1", "s1"]);
  });

  it("detects cancelable work from each class alone", () => {
    expect(build().coordinator.hasCancelableWork()).toBe(false);
    expect(build({ running: true }).coordinator.hasCancelableWork()).toBe(true);
    expect(build({ compacting: true }).coordinator.hasCancelableWork()).toBe(true);
    expect(build({ runningJobs: 1 }).coordinator.hasCancelableWork()).toBe(true);
    expect(
      build({ pendingNotifications: 1 }).coordinator.hasCancelableWork(),
    ).toBe(true);
    expect(
      build({ interruptibleWork: true }).coordinator.hasCancelableWork(),
    ).toBe(true);
  });

  it("does not count queued prompts as cancelable work", () => {
    const { coordinator } = build({ queued: ["next"] });
    expect(coordinator.hasCancelableWork()).toBe(false);
    expect(coordinator.snapshot().queuedPrompts).toBe(1);
  });

  it("cancels interruptible work before aborting a running turn", () => {
    const { coordinator, calls } = build({
      running: true,
      interruptibleWork: true,
    });
    expect(coordinator.abortForeground()).toEqual({
      turnAborted: true,
      interruptibleCancelled: 1,
    });
    expect(calls).toEqual(["interruptible.cancelAll:1", "session.abort"]);
  });

  it("reports idle outcome when nothing is running", () => {
    const { coordinator, calls } = build();
    expect(coordinator.abortForeground()).toEqual({
      turnAborted: false,
      interruptibleCancelled: 0,
    });
    expect(calls).toEqual(["interruptible.cancelAll:0"]);
  });

  it("merges the session result into the cancel-all outcome", async () => {
    const { coordinator, calls } = build({
      running: true,
      compacting: true,
      interruptibleWork: true,
    });
    const outcome = await coordinator.cancelAll();
    expect(outcome.ok).toBe(true);
    expect(outcome.turnAborted).toBe(true);
    expect(outcome.compactionAborted).toBe(true);
    expect(outcome.interruptibleCancelled).toBe(1);
    expect(outcome.sessionResult.ok).toBe(true);
    expect(calls).toEqual(["interruptible.cancelAll:1", "session.cancelAll"]);
  });

  it("surfaces job stop failures from the session cancel-all result", async () => {
    const { coordinator } = build({ running: true, cancelAllOk: false });
    const outcome = await coordinator.cancelAll();
    expect(outcome.ok).toBe(false);
    expect(outcome.sessionResult.ok).toBe(false);
  });
});
