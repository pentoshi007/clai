import { describe, expect, it } from "vitest";
import {
  createPlanContextTracker,
  PLAN_UPDATE_PREFIX,
  PLAN_UPDATE_RESNAPSHOT_LINES,
} from "../../src/agent/plan/context-delta.js";
import { planContextMessage } from "../../src/agent/plan/context-message.js";
import type { SessionPlan, TaskState } from "../../src/store/plan.js";
import type { ChatMessage } from "../../src/types.js";

const plan = (states: TaskState[], overrides: Partial<SessionPlan> = {}): SessionPlan => ({
  sessionId: "s1" as SessionPlan["sessionId"],
  goal: "Ship the feature",
  detail: "Build and verify",
  kind: "coding",
  status: "executing",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tasks: states.map((state, index) => ({ id: `t${index + 1}`, title: `Task ${index + 1}`, state })),
  ...overrides,
});

const planBlocks = (messages: readonly ChatMessage[]): string[] =>
  messages.filter((message) => message.content.startsWith("ACTIVE PLAN")).map((message) => message.content);

describe("plan context tracker", () => {
  it("emits one snapshot, then compact updates for state-only changes", () => {
    const messages: ChatMessage[] = [];
    const tracker = createPlanContextTracker();
    tracker.emit(messages, plan(["in_progress", "pending"]), true);
    tracker.emit(messages, plan(["in_progress", "pending"]), true);
    tracker.emit(messages, plan(["done", "in_progress"]), true);

    const blocks = planBlocks(messages);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(planContextMessage(plan(["in_progress", "pending"]), true));
    expect(blocks[1]!.startsWith(PLAN_UPDATE_PREFIX)).toBe(true);
    expect(blocks[1]).toContain("t1: in_progress → done");
    expect(blocks[1]).toContain("t2: pending → in_progress");
    expect(blocks[1]).toContain("Next: RESUME TASK t2");
    expect(blocks[1]!.length).toBeLessThan(blocks[0]!.length / 4);
  });

  it("re-snapshots when the plan structure or approval changes", () => {
    const messages: ChatMessage[] = [];
    const tracker = createPlanContextTracker();
    tracker.emit(messages, plan(["pending"], { status: "draft" }), false);
    tracker.emit(messages, plan(["pending"], { status: "approved" }), true);
    tracker.emit(messages, plan(["in_progress", "pending"], { status: "approved" }), true);

    const blocks = planBlocks(messages);
    expect(blocks).toHaveLength(3);
    expect(blocks.every((block) => !block.startsWith(PLAN_UPDATE_PREFIX))).toBe(true);
    expect(blocks[2]).toBe(planContextMessage(plan(["in_progress", "pending"], { status: "approved" }), true));
  });

  it("re-snapshots when another writer replaced the latest plan block", () => {
    const messages: ChatMessage[] = [];
    const tracker = createPlanContextTracker();
    tracker.emit(messages, plan(["in_progress", "pending"]), true);
    const compacted: ChatMessage[] = [{ role: "system", content: "memory" }];
    messages.splice(0, messages.length, ...compacted);
    tracker.emit(messages, plan(["done", "in_progress"]), true);

    expect(planBlocks(messages)).toEqual([planContextMessage(plan(["done", "in_progress"]), true)]);
  });

  it("re-snapshots once accumulated update lines exceed the bound", () => {
    const messages: ChatMessage[] = [];
    const tracker = createPlanContextTracker();
    const size = PLAN_UPDATE_RESNAPSHOT_LINES + 2;
    const states = (done: number): TaskState[] =>
      Array.from({ length: size }, (_, index) => (index < done ? "done" : "pending"));
    tracker.emit(messages, plan(states(0)), true);
    for (let done = 1; done <= PLAN_UPDATE_RESNAPSHOT_LINES + 1; done += 1) {
      tracker.emit(messages, plan(states(done)), true);
    }

    const blocks = planBlocks(messages);
    const updates = blocks.filter((block) => block.startsWith(PLAN_UPDATE_PREFIX));
    expect(updates).toHaveLength(PLAN_UPDATE_RESNAPSHOT_LINES);
    expect(blocks.at(-1)).toBe(planContextMessage(plan(states(PLAN_UPDATE_RESNAPSHOT_LINES + 1)), true));
  });

  it("omits the next-task directive for unapproved plans", () => {
    const messages: ChatMessage[] = [];
    const tracker = createPlanContextTracker();
    tracker.emit(messages, plan(["pending", "pending"], { status: "draft" }), false);
    tracker.emit(messages, plan(["skipped", "pending"], { status: "draft" }), false);
    expect(planBlocks(messages)[1]).not.toContain("Next:");
  });
});
