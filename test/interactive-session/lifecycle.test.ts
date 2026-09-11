import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  InteractiveSessionManager,
  type ConfirmPreview,
} from "../../src/interactive-session/manager.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import { systemClock, type Clock } from "../../src/interactive-session/runtime.js";
import {
  SessionErrorException,
  isTerminalState,
} from "../../src/interactive-session/types.js";
import { FakeClock, FakeTransportFactory, tempArtifactDir } from "./helpers.js";

const OWNER = "conv-1";
const approve: ConfirmPreview = async () => true;
let dirs: string[] = [];

function build(
  clock: Clock = systemClock,
  config: Record<string, unknown> = {},
  factoryOptions: ConstructorParameters<typeof FakeTransportFactory>[0] = {
    ptyAvailable: false,
  },
) {
  const dir = tempArtifactDir();
  dirs.push(dir);
  const factory = new FakeTransportFactory(factoryOptions);
  const manager = new InteractiveSessionManager({
    transports: factory,
    clock,
    artifactBaseDir: dir,
    journal: new RecoveryJournal(join(dir, "journal")),
    telemetry: new SessionTelemetry(async () => undefined),
    config,
  });
  return { manager, factory };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Feature: interactive-terminal-sessions, Property 6: Quiet gathering obeys one absolute deadline
describe("Property 6: quiet gathering obeys one absolute deadline", () => {
  it("stops at the quiet interval once output settles after delivery", async () => {
    const clock = new FakeClock();
    const { manager, factory } = build(clock);
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    const transport = factory.last();
    const pending = manager.send({
      ownerId: OWNER,
      id: started.sessionId,
      input: { kind: "text", text: "y", submit: "enter" },
      quietMs: 100,
      deadlineMs: 5_000,
      confirm: approve,
    });
    // Let delivery settle, then keep output flowing so quiet detection extends.
    await new Promise((resolve) => setTimeout(resolve, 20));
    transport.emit("first ");
    await clock.advance(60);
    transport.emit("second");
    await clock.advance(60);
    expect(transport.writes).toHaveLength(1);
    await clock.advance(100);
    const result = await pending;
    expect(result.error).toBeUndefined();
    const text = result.page?.events.map((event) => event.content).join("");
    expect(text).toBe("first second");
  });

  it("returns the gathered page with a non-retryable deadline error", async () => {
    const clock = new FakeClock();
    const { manager, factory } = build(clock);
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    const transport = factory.last();
    const pending = manager.send({
      ownerId: OWNER,
      id: started.sessionId,
      input: { kind: "text", text: "y", submit: "enter" },
      quietMs: 5_000,
      deadlineMs: 1_000,
      confirm: approve,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    transport.emit("partial");
    await clock.advance(1_000);
    const result = await pending;
    expect(result.error?.code).toBe("DEADLINE_EXCEEDED");
    expect(result.error?.retryable).toBe(false);
    expect(result.page?.events.map((event) => event.content).join("")).toBe("partial");
    expect(result.page?.nextCursor).toBe(7);
  });

  it("treats operation cancellation as wait cleanup and keeps the session live", async () => {
    const clock = new FakeClock();
    const { manager } = build(clock);
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    const controller = new AbortController();
    const pending = manager.send({
      ownerId: OWNER,
      id: started.sessionId,
      input: { kind: "text", text: "y", submit: "enter" },
      quietMs: 5_000,
      deadlineMs: 60_000,
      confirm: approve,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(result.error?.code).toBe("CANCELLED");
    expect(manager.status({ ownerId: OWNER, id: started.sessionId }).session.state).toBe("running");
  });

  it("returns immediately for a non-blocking read and honors the wait cap", async () => {
    const clock = new FakeClock();
    const { manager, factory } = build(clock);
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    factory.last().emit("ready");
    const immediate = await manager.read({ ownerId: OWNER, id: started.sessionId, cursor: 0 });
    expect(immediate.page?.events.map((event) => event.content).join("")).toBe("ready");

    const blocking = manager.read({
      ownerId: OWNER,
      id: started.sessionId,
      cursor: 5,
      waitMs: 120_000,
    });
    await clock.advance(29_999);
    factory.last().emit("late");
    const result = await blocking;
    expect(result.page?.events.map((event) => event.content).join("")).toBe("late");
  });

  it("holds across generated delivery, output, deadline, exit, and cancellation schedules", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          mode: fc.constantFrom(
            "quiet",
            "deadline",
            "operation-cancel",
            "owner-cancel",
            "exit",
            "read-output",
            "read-cancel",
          ),
          quietMs: fc.integer({ min: 25, max: 200 }),
          deliveryDelay: fc.integer({ min: 0, max: 40 }),
          eventDelay: fc.integer({ min: 1, max: 20 }),
          explicitCursor: fc.boolean(),
          postDeliveryOutput: fc.boolean(),
        }),
        async (schedule) => {
          const clock = new FakeClock();
          let releaseDelivery = (): void => undefined;
          const deliveryBarrier = new Promise<void>((resolve) => {
            releaseDelivery = resolve;
          });
          const { manager, factory } = build(clock, {}, {
            ptyAvailable: false,
            transportOptions: { beforeWrite: () => deliveryBarrier },
          });
          const started = await manager.start({
            ownerId: OWNER,
            command: "cmd",
            confirm: approve,
          });
          const transport = factory.last();
          transport.emit("prefix");
          await flushMicrotasks();

          if (schedule.mode === "read-output" || schedule.mode === "read-cancel") {
            const controller = new AbortController();
            const pendingRead = manager.read({
              ownerId: OWNER,
              id: started.sessionId,
              cursor: 6,
              waitMs: 30_000,
              signal: controller.signal,
            });
            await clock.advance(schedule.eventDelay);
            if (schedule.mode === "read-output") transport.emit("read");
            else controller.abort();
            const result = await pendingRead;
            if (schedule.mode === "read-output") {
              expect(result.error).toBeUndefined();
              expect(result.page?.events.map((event) => event.content).join("")).toBe("read");
            } else {
              expect(result.error?.code).toBe("CANCELLED");
              expect(manager.status({ ownerId: OWNER, id: started.sessionId }).session.state).toBe(
                "running",
              );
            }
            return;
          }

          const deadlineMs =
            schedule.mode === "deadline"
              ? Math.max(100, schedule.deliveryDelay + 30)
              : schedule.deliveryDelay + schedule.eventDelay + schedule.quietMs + 100;
          const controller = new AbortController();
          let settled = false;
          const pendingSend = manager
            .send({
              ownerId: OWNER,
              id: started.sessionId,
              input: { kind: "text", text: "input", submit: "enter" },
              quietMs: schedule.mode === "deadline" ? 5_000 : schedule.quietMs,
              deadlineMs,
              confirm: approve,
              signal: controller.signal,
              ...(schedule.explicitCursor ? { cursor: 0 } : {}),
            })
            .finally(() => {
              settled = true;
            });
          await flushMicrotasks();
          await clock.advance(schedule.deliveryDelay);
          transport.emit("pre");
          await flushMicrotasks();
          releaseDelivery();
          await flushMicrotasks();

          if (schedule.mode === "quiet") {
            if (schedule.postDeliveryOutput) {
              await clock.advance(schedule.eventDelay);
              transport.emit("post");
              await flushMicrotasks();
            }
            await clock.advance(schedule.quietMs - 1);
            expect(settled).toBe(false);
            await clock.advance(1);
          } else if (schedule.mode === "deadline") {
            const remaining = deadlineMs - schedule.deliveryDelay;
            const beforeOutput = Math.max(1, Math.floor(remaining / 2));
            await clock.advance(beforeOutput);
            transport.emit("post");
            await clock.advance(remaining - beforeOutput - 1);
            expect(settled).toBe(false);
            await clock.advance(1);
          } else if (schedule.mode === "operation-cancel") {
            await clock.advance(schedule.eventDelay);
            controller.abort();
          } else if (schedule.mode === "owner-cancel") {
            await clock.advance(schedule.eventDelay);
            const closing = manager.cancelOwner(OWNER);
            for (let index = 0; index < 4; index += 1) {
              await flushMicrotasks();
              await clock.advance(30_000);
            }
            await closing;
          } else {
            await clock.advance(schedule.eventDelay);
            transport.emitExit();
          }

          const result = await pendingSend;
          if (schedule.mode === "deadline") expect(result.error?.code).toBe("DEADLINE_EXCEEDED");
          if (schedule.mode === "operation-cancel") {
            expect(result.error?.code).toBe("CANCELLED");
            expect(manager.status({ ownerId: OWNER, id: started.sessionId }).session.state).toBe(
              "running",
            );
          }
          if (schedule.mode === "owner-cancel") {
            const finalState = manager.status({
              ownerId: OWNER,
              id: started.sessionId,
            }).session.state;
            expect(isTerminalState(finalState)).toBe(true);
            expect(transport.disposed).toBe(1);
          }
          const content = result.page?.events.map((event) => event.content).join("") ?? "";
          if (schedule.mode !== "owner-cancel") {
            expect(content.startsWith(schedule.explicitCursor ? "prefixpre" : "pre")).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 30_000);
});

// Feature: interactive-terminal-sessions, Property 19: Activity and lifetime timers have independent invariants
describe("Property 19: activity and lifetime timers are independent", () => {
  it("resets idle expiry on activity but never extends lifetime", async () => {
    const clock = new FakeClock();
    const { manager, factory } = build(clock, {
      idleTimeoutMs: 1_000,
      lifetimeTimeoutMs: 3_000,
    });
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    const transport = factory.last();
    for (let tick = 0; tick < 3; tick += 1) {
      await clock.advance(900);
      transport.emit("keepalive");
      expect(manager.status({ ownerId: OWNER, id: started.sessionId }).session.state).toBe(
        "running",
      );
    }
    // Lifetime is fixed from launch, so activity cannot postpone it.
    await clock.advance(500);
    await expect.poll(() => isTerminalState(
      manager.status({ ownerId: OWNER, id: started.sessionId }).session.state,
    ), { timeout: 3000 }).toBe(true);
    const session = manager.status({ ownerId: OWNER, id: started.sessionId }).session;
    expect(isTerminalState(session.state)).toBe(true);
    expect(session.terminationReason).toBe("lifetime-timeout");
  });

  it("closes an idle session with the idle reason", async () => {
    const clock = new FakeClock();
    const { manager } = build(clock, { idleTimeoutMs: 1_000 });
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    await clock.advance(1_000);
    await expect.poll(() => isTerminalState(
      manager.status({ ownerId: OWNER, id: started.sessionId }).session.state,
    ), { timeout: 3000 }).toBe(true);
    expect(
      manager.status({ ownerId: OWNER, id: started.sessionId }).session.terminationReason,
    ).toBe("idle-timeout");
  });
});

// Feature: interactive-terminal-sessions, Property 18: Closing rejects later input and finalizes once
describe("Property 18: closing rejects later input and finalizes once", () => {
  it("finalizes once under racing triggers and returns a stable terminal result", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(
          ["close", "exit", "cancelOwner", "teardown", "shutdown"] as const,
          { minLength: 2 },
        ),
        async (triggers) => {
          const { manager, factory } = build();
          const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
          const transport = factory.last();
          await Promise.all(
            triggers.map((trigger) => {
              switch (trigger) {
                case "close":
                  return manager.close({ ownerId: OWNER, id: started.sessionId });
                case "exit":
                  transport.emitExit();
                  return Promise.resolve();
                case "cancelOwner":
                  return manager.cancelOwner(OWNER);
                case "teardown":
                  return manager.beginCloseOwner(OWNER);
                default:
                  return manager.closeAll();
              }
            }),
          );
          const session = manager.status({ ownerId: OWNER, id: started.sessionId }).session;
          expect(isTerminalState(session.state)).toBe(true);
          // Exactly one teardown released the transport.
          expect(transport.disposed).toBe(1);
          const repeated = await manager.close({ ownerId: OWNER, id: started.sessionId });
          expect(repeated.state).toBe(session.state);
          expect(transport.disposed).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects input submitted after closing began", async () => {
    const { manager } = build();
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    await manager.close({ ownerId: OWNER, id: started.sessionId });
    let code: string | undefined;
    try {
      await manager.send({
        ownerId: OWNER,
        id: started.sessionId,
        input: { kind: "text", text: "y", submit: "enter" },
        confirm: approve,
      });
    } catch (error) {
      code = (error as SessionErrorException).stable.code;
    }
    expect(code).toBe("SESSION_NOT_RUNNING");
  });

  it("fences a torn-down owner against new sessions", async () => {
    const { manager } = build();
    await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    await manager.beginCloseOwner(OWNER);
    let code: string | undefined;
    try {
      await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    } catch (error) {
      code = (error as SessionErrorException).stable.code;
    }
    expect(code).toBe("SESSION_CLOSING");
  });

  it("reactivates a previously torn-down owner after another owner runs", async () => {
    const { manager } = build();
    await manager.start({ ownerId: "owner-a", command: "a", confirm: approve });
    await manager.beginCloseOwner("owner-a");
    await manager.start({ ownerId: "owner-b", command: "b", confirm: approve });
    await manager.beginCloseOwner("owner-b");
    await manager.activateOwner("owner-a");
    const resumed = await manager.start({ ownerId: "owner-a", command: "a", confirm: approve });
    expect(resumed.state).toBe("running");
  });

  it("records a process exit as exited and releases resources once", async () => {
    const { manager, factory } = build();
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    const transport = factory.last();
    transport.emit("bye\n");
    transport.emitExit({ code: 3 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const session = manager.status({ ownerId: OWNER, id: started.sessionId }).session;
    expect(session.state).toBe("exited");
    expect(session.processOutcome?.exitCode).toBe(3);
    expect(session.terminationReason).toBe("process-exit");
    expect(transport.disposed).toBe(1);
  });
});

describe("owner scoping and cancellation boundaries", () => {
  it("hides another conversation's session behind SESSION_NOT_FOUND", async () => {
    const { manager } = build();
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    for (const operation of ["status", "close"] as const) {
      let code: string | undefined;
      try {
        if (operation === "status") manager.status({ ownerId: "other", id: started.sessionId });
        else await manager.close({ ownerId: "other", id: started.sessionId });
      } catch (error) {
        code = (error as SessionErrorException).stable.code;
      }
      expect(code).toBe("SESSION_NOT_FOUND");
    }
  });

  it("closes only the cancelled owner's sessions", async () => {
    const { manager } = build();
    const mine = await manager.start({ ownerId: OWNER, command: "a", confirm: approve });
    const theirs = await manager.start({ ownerId: "conv-2", command: "b", confirm: approve });
    const result = await manager.cancelOwner(OWNER);
    expect(result.closed).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(manager.status({ ownerId: OWNER, id: mine.sessionId }).session.terminationReason).toBe(
      "cancelled",
    );
    expect(manager.status({ ownerId: "conv-2", id: theirs.sessionId }).session.state).toBe(
      "running",
    );
  });

  it("lists only the owner's sessions", async () => {
    const { manager } = build();
    const mine = await manager.start({ ownerId: OWNER, command: "a", confirm: approve });
    await manager.start({ ownerId: "conv-2", command: "b", confirm: approve });
    const listed = manager.list({ ownerId: OWNER });
    expect(listed.sessions.map((session) => session.id)).toEqual([mine.sessionId]);
  });
});
