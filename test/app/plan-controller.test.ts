import { describe, expect, it } from "vitest";
import { asPlanId, asSessionId } from "../../src/app/events/app-event.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import { PlanController } from "../../src/app/controllers/plan-controller.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import type { SessionPlan } from "../../src/store/plan.js";

function fakePersistence(): PersistencePort & { saved: SessionPlan[]; deleted: string[] } {
  const saved: SessionPlan[] = [];
  const deleted: string[] = [];
  return {
    saved,
    deleted,
    async saveSession() {},
    async loadPlan(sessionId) {
      return saved.find((p) => p.sessionId === sessionId);
    },
    async savePlan(plan) {
      saved.push(plan);
    },
    async deletePlan(sessionId) {
      deleted.push(sessionId);
    },
  };
}

function plan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    sessionId: "s1",
    goal: "goal",
    detail: "detail",
    tasks: [],
    status: "draft",
    kind: "coding",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("PlanController observability (V2-070)", () => {
  it("notifies subscribers when a plan-updated event lands", () => {
    const controller = new PlanController(fakePersistence());
    let notifications = 0;
    controller.subscribe(() => (notifications += 1));

    const sequencer = new EventSequencer(asSessionId("s1"));
    controller.observe(sequencer.build("plan-updated", { planId: asPlanId("p1"), plan: plan() }, undefined));

    expect(notifications).toBe(1);
    expect(controller.current()).toEqual(plan());
  });

  it("ignores unrelated events without notifying", () => {
    const controller = new PlanController(fakePersistence());
    let notifications = 0;
    controller.subscribe(() => (notifications += 1));

    const sequencer = new EventSequencer(asSessionId("s1"));
    controller.observe(sequencer.build("turn-started", { prompt: "hi" }, undefined));

    expect(notifications).toBe(0);
    expect(controller.current()).toBeUndefined();
  });

  it("notifies on load/approve/discard", async () => {
    const persistence = fakePersistence();
    persistence.saved.push(plan());
    const controller = new PlanController(persistence);
    let notifications = 0;
    controller.subscribe(() => (notifications += 1));

    await controller.load("s1");
    expect(notifications).toBe(1);
    expect(controller.current()?.status).toBe("draft");

    await controller.approve();
    expect(notifications).toBe(2);
    expect(controller.current()?.status).toBe("approved");
    expect(persistence.saved.at(-1)?.status).toBe("approved");

    await controller.discard();
    expect(notifications).toBe(3);
    expect(controller.current()).toBeUndefined();
    expect(persistence.deleted).toContain("s1");
  });

  it("unsubscribe stops further notifications", () => {
    const controller = new PlanController(fakePersistence());
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => (notifications += 1));
    unsubscribe();

    const sequencer = new EventSequencer(asSessionId("s1"));
    controller.observe(sequencer.build("plan-updated", { planId: asPlanId("p1"), plan: plan() }, undefined));
    expect(notifications).toBe(0);
  });
});
