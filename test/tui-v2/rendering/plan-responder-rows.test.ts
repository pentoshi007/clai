import { describe, expect, it } from "vitest";
import {
  activeTaskId,
  taskGlyph,
  taskOwnerChip,
  taskRowColor,
  TASK_GLYPH,
} from "../../../src/ui-core/rendering/plan-view.js";
import type { PlanTask, SessionPlan, TaskState } from "../../../src/store/plan.js";

function task(partial: Partial<PlanTask> & { id: string }): PlanTask {
  return {
    title: `task ${partial.id}`,
    state: "pending",
    ...partial,
  } as PlanTask;
}

function plan(tasks: PlanTask[]): SessionPlan {
  return {
    sessionId: "s1",
    goal: "goal",
    detail: "",
    tasks,
    status: "in_progress",
    kind: "coding",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("responder rows in the plan pane (TUI-006)", () => {
  it("keeps active responder rails cyan and terminal rails state-colored", () => {
    for (const state of ["pending", "in_progress"] as TaskState[]) {
      expect(taskRowColor(task({ id: "c1", state, responderOwned: true }))).toBe("cyan");
    }
    expect(taskRowColor(task({ id: "c1", state: "done", responderOwned: true }))).toBe("success");
    expect(taskRowColor(task({ id: "c2", state: "failed", responderOwned: true }))).toBe(
      "diffDel",
    );
  });

  it("leaves foreground rows on their state colors", () => {
    expect(taskRowColor(task({ id: "t1", state: "in_progress" }))).toBe("activity");
    expect(taskRowColor(task({ id: "t2", state: "done" }))).toBe("success");
  });

  it("uses background glyphs for responder rows", () => {
    expect(taskGlyph(task({ id: "t1", state: "in_progress" }))).toBe(
      TASK_GLYPH.in_progress,
    );
    expect(taskGlyph(task({ id: "c1", state: "in_progress", responderOwned: true }))).toBe(
      "⟳",
    );
    expect(taskGlyph(task({ id: "c2", state: "pending", responderOwned: true }))).toBe("◌");
  });

  it("labels the responder phase and never labels foreground work", () => {
    expect(taskOwnerChip(task({ id: "t1", state: "in_progress" }))).toBeUndefined();
    expect(
      taskOwnerChip(task({ id: "c1", state: "in_progress", responderOwned: true })),
    ).toBe("RESPONDER · RUNNING");
    expect(taskOwnerChip(task({ id: "c2", state: "pending", responderOwned: true }))).toBe(
      "RESPONDER · QUEUED",
    );
    expect(taskOwnerChip(task({ id: "c3", state: "done", responderOwned: true }))).toBe(
      "RESPONDER · DELIVERED",
    );
  });

  it("scrolls/highlights only the foreground task while responders run", () => {
    const current = plan([
      task({ id: "t1", state: "done" }),
      task({ id: "c1", state: "in_progress", responderOwned: true }),
      task({ id: "t2", state: "in_progress" }),
      task({ id: "c2", state: "in_progress", responderOwned: true }),
    ]);
    expect(activeTaskId(current)).toBe("t2");
  });
});
