import { describe, expect, it, vi } from "vitest";
import { asPlanId, asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import type { AgentPort } from "../../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import type { SessionPlan } from "../../../src/store/plan.js";
import type { ChatMessage } from "../../../src/types.js";
import { createCompositionRoot } from "../../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../../src/ui-core/bootstrap/capabilities.js";
import { createTurnOutcome } from "../../../src/agent/turn-outcome.js";
import {
  beginPlanSuggestion,
  clearAwaitingPlanSuggestion,
  consumePlanSuggestionInput,
  discardPlan,
  IMPLEMENT_PROMPT,
  implementPlan,
  isAwaitingPlanSuggestion,
  promptPlanApprovalIfNeeded,
} from "../../../src/ui-core/plan/plan-lifecycle.js";
import { shouldBlockPlanModeMutate } from "../../../src/agent/plan-decision.js";
import { hydrateSessionVisual } from "../../../src/ui-core/state/transcript-hydrate.js";

const completeWithProvider = vi.hoisted(() => vi.fn());
vi.mock("../../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/llm/router.js")>();
  return {
    ...actual,
    completeWithProvider: (...args: unknown[]) => completeWithProvider(...args),
    streamWithProvider: async (
      request: unknown,
      onToken: (text: string) => void,
    ) => {
      const result = await completeWithProvider(request);
      onToken(String(result.text ?? ""));
      return result;
    },
  };
});

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
      return createTurnOutcome({ status: "succeeded", answer: "", steps: 0, remainingCriteria: [] });
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
  it("pane implement dismisses open plan confirm without double-submit", async () => {
    const calls: string[] = [];
    const services = build(calls);
    const draft = plan();
    seedDraft(services, draft);
    const confirmP = services.overlay.openConfirm({
      kind: "plan",
      prompt: "Implement?",
    });
    expect(services.overlay.getState().kind).toBe("confirm");
    await implementPlan(services);
    // Confirm must be closed; only one implement prompt submitted.
    expect(services.overlay.getState().kind).toBe("none");
    await expect(confirmP).resolves.toBe(true);
    expect(calls).toEqual([IMPLEMENT_PROMPT]);
  });

  it("implementPlan approves, switches to agent, and submits the implement prompt", async () => {
    const calls: string[] = [];
    const services = build(calls);
    services.session.setMode("plan");
    seedDraft(services);

    await implementPlan(services);

    expect(services.plan.current()?.status).toBe("approved");
    expect(services.session.isPlanApproved()).toBe(true);
    expect(services.session.getState().mode).toBe("agent");
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
    services.session.setMode("plan");
    seedDraft(services);

    const pending = promptPlanApprovalIfNeeded(services);
    expect(services.overlay.getState().kind).toBe("confirm");
    services.overlay.answerPlanConfirm("implement");
    await pending;

    expect(services.plan.current()?.status).toBe("approved");
    expect(services.session.getState().mode).toBe("agent");
    expect(calls).toEqual([IMPLEMENT_PROMPT]);
  });

  it("promptPlanApprovalIfNeeded discards on N", async () => {
    const services = build();
    seedDraft(services);

    const pending = promptPlanApprovalIfNeeded(services);
    services.overlay.answerPlanConfirm("discard");
    await pending;

    expect(services.plan.current()).toBeUndefined();
  });

  it("promptPlanApprovalIfNeeded suggest does not implement or discard", async () => {
    const calls: string[] = [];
    const services = build(calls);
    seedDraft(services);
    clearAwaitingPlanSuggestion();

    const pending = promptPlanApprovalIfNeeded(services);
    services.overlay.answerPlanConfirm("suggest");
    await pending;

    expect(services.plan.current()?.status).toBe("draft");
    expect(services.session.isPlanApproved()).toBe(false);
    expect(calls).toEqual([]);
    expect(isAwaitingPlanSuggestion()).toBe(true);

    const revision = consumePlanSuggestionInput(
      services,
      "add a dark mode task and use bun",
    );
    expect(revision?.modelPrompt).toMatch(/Plan revision request/);
    expect(revision?.modelPrompt).toMatch(/add a dark mode task and use bun/);
    expect(revision?.displayPrompt).toBe("add a dark mode task and use bun");
    expect(isAwaitingPlanSuggestion()).toBe(false);
  });

  it("promptPlanApprovalIfNeeded dismiss leaves draft pending", async () => {
    const services = build();
    seedDraft(services);

    const pending = promptPlanApprovalIfNeeded(services);
    services.overlay.answerPlanConfirm("dismiss");
    await pending;

    expect(services.plan.current()?.status).toBe("draft");
    expect(services.session.isPlanApproved()).toBe(false);
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

  it("restores messages, transcript, and exact context when compaction is rejected", async () => {
    completeWithProvider.mockResolvedValueOnce({ text: "tiny" });
    const sessionSaves: Array<{
      messages: readonly ChatMessage[];
      options: Parameters<PersistencePort["saveSession"]>[1];
    }> = [];
    const persistence: PersistencePort = {
      async saveSession(messages, options) {
        sessionSaves.push({
          messages: messages.map((message) => ({ ...message })),
          options: options ? { ...options } : undefined,
        });
      },
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    };
    const services = createCompositionRoot({
      agent: fakeAgent([]),
      persistence,
      provider: "groq" as never,
      model: "test-model",
      capabilities: detectCapabilities({
        env: {},
        stdoutIsTTY: true,
        stdinIsTTY: true,
        columns: 120,
        rows: 40,
      }),
    });
    seedDraft(services);
    const heavy = "research evidence ".repeat(1_200);
    const messages: ChatMessage[] = [
      { role: "user", content: heavy },
      { role: "assistant", content: heavy },
      { role: "user", content: heavy },
      { role: "assistant", content: heavy },
      { role: "user", content: "recent instruction" },
      { role: "assistant", content: "recent response" },
    ];
    services.session.loadHistory(messages, {
      sessionId: "s1",
      persistenceRevision: 7,
      contextUsage: {
        contextTokens: 88_000,
        contextLimit: 128_000,
        exact: true,
      },
    });
    services.transcript.hydrate(
      hydrateSessionVisual(undefined, messages).state,
    );

    await implementPlan(services);

    expect(completeWithProvider).toHaveBeenCalled();
    const restored = sessionSaves.find(
      (entry) =>
        entry.messages.length === messages.length &&
        entry.options?.contextUsage?.contextTokens === 88_000,
    );
    expect(restored).toBeDefined();
    expect(restored?.options?.transcript?.some((item) => item.kind === "compacted")).toBe(
      false,
    );
    expect(
      [...services.transcript.getState().byId.values()].some(
        (item) => item.kind === "compacted",
      ),
    ).toBe(false);
    expect(services.session.getState().contextUsage?.contextTokens).toBe(88_000);
  });

  it("shouldBlockPlanModeMutate only while unapproved", () => {
    expect(shouldBlockPlanModeMutate(true, false)).toBe(true);
    expect(shouldBlockPlanModeMutate(true, true)).toBe(false);
    expect(shouldBlockPlanModeMutate(false, false)).toBe(false);
  });

  it("beginPlanSuggestion arms free-text capture without approving", () => {
    const services = build();
    seedDraft(services);
    clearAwaitingPlanSuggestion();
    beginPlanSuggestion(services);
    expect(isAwaitingPlanSuggestion()).toBe(true);
    expect(services.session.isPlanApproved()).toBe(false);
    expect(services.plan.current()?.status).toBe("draft");
    clearAwaitingPlanSuggestion();
  });
});
