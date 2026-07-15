import { describe, expect, it, vi } from "vitest";
import { asPlanId, asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import type { AgentPort } from "../../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import type { SessionPlan } from "../../../src/store/plan.js";
import { createCompositionRoot } from "../../../src/tui-v2/bootstrap/composition-root.js";
import { detectCapabilities } from "../../../src/tui-v2/bootstrap/capabilities.js";
import {
  discardPlan,
  IMPLEMENT_PROMPT,
  implementPlan,
  promptPlanApprovalIfNeeded,
} from "../../../src/tui-v2/app/plan-lifecycle.js";

function plan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    sessionId: "s1",
    goal: "Ship it",
    detail: "full detail",
    tasks: [{ id: "t1", title: "one", state: "pending" }],
    status: "draft",
    kind: "coding",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakePersistence(): PersistencePort & { saved: SessionPlan[]; deleted: string[] } {
  const saved: SessionPlan[] = [];
  const deleted: string[] = [];
  return {
    saved,
    deleted,
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan(p) {
      saved.push(p);
    },
    async deletePlan(sessionId) {
      deleted.push(sessionId);
    },
  };
}

function fakeAgent(calls: string[]): AgentPort {
  return {
    async runTurn(request) {
      calls.push(request.prompt);
      return "";
    },
  };
}

function build(agentCalls: string[] = []) {
  return createCompositionRoot({
    agent: fakeAgent(agentCalls),
    persistence: fakePersistence(),
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
  });
}

function seedDraft(services: ReturnType<typeof build>, draft: SessionPlan = plan()): void {
  services.plan.observe(
    new EventSequencer(asSessionId("s1")).build(
      "plan-updated",
      { planId: asPlanId("p1"), plan: draft },
      undefined,
    ),
  );
}

describe("plan lifecycle (PLAN-004, F-021/023, V2-070)", () => {
  it("implementPlan approves, sets session flag, and submits the implement prompt", async () => {
    const calls: string[] = [];
    const services = build(calls);
    seedDraft(services);

    await implementPlan(services);

    expect(services.plan.current()?.status).toBe("approved");
    expect(services.session.isPlanApproved()).toBe(true);
    expect(calls).toEqual([IMPLEMENT_PROMPT]);
  });

  it("discardPlan clears the plan and the session approval flag", async () => {
    const services = build();
    seedDraft(services);
    services.session.setPlanApproved(true);

    await discardPlan(services);

    expect(services.plan.current()).toBeUndefined();
    expect(services.session.isPlanApproved()).toBe(false);
  });

  it("promptPlanApprovalIfNeeded implements on Y", async () => {
    const calls: string[] = [];
    const services = build(calls);
    seedDraft(services);

    const pending = promptPlanApprovalIfNeeded(services);
    expect(services.overlay.getState().kind).toBe("confirm");
    services.overlay.answerConfirm(true);
    await pending;

    expect(services.plan.current()?.status).toBe("approved");
    expect(calls).toEqual([IMPLEMENT_PROMPT]);
  });

  it("promptPlanApprovalIfNeeded discards on N", async () => {
    const services = build();
    seedDraft(services);

    const pending = promptPlanApprovalIfNeeded(services);
    services.overlay.answerConfirm(false);
    await pending;

    expect(services.plan.current()).toBeUndefined();
  });

  it("skips the prompt when already approved or no draft tasks", async () => {
    const services = build();
    seedDraft(services, plan({ tasks: [] }));
    await promptPlanApprovalIfNeeded(services);
    expect(services.overlay.getState().kind).toBe("none");

    seedDraft(services);
    services.session.setPlanApproved(true);
    await promptPlanApprovalIfNeeded(services);
    expect(services.overlay.getState().kind).toBe("none");
  });

  it("fires onTurnEnd after submit so the shell can prompt for plan approval", async () => {
    const services = build();
    const listener = vi.fn();
    services.session.onTurnEnd(listener);
    await services.session.submit("hello");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ status: "completed" });
  });
});
