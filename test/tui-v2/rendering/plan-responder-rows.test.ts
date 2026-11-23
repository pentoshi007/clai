import { describe, expect, it } from "vitest";
import {
  activeTaskId,
  taskGlyph,
  cleanTaskTitle,
  taskPaneGlyph,
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
  it.each<{ state: TaskState; color: string }>([
    { state: "pending", color: "foreground" },
    { state: "in_progress", color: "activity" },
    { state: "done", color: "success" },
    { state: "failed", color: "diffDel" },
    { state: "skipped", color: "muted" },
  ])("uses the same $state color for responder and foreground rows", ({ state, color }) => {
    expect(taskRowColor(task({ id: "c1", state, responderOwned: true }))).toBe(color);
    expect(taskRowColor(task({ id: "t1", state }))).toBe(color);
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

  it("uses a safe label only for legacy Responder titles", () => {
    const legacy = task({ id: "c1", title: "[c1]: Responder · npm test", responderOwned: true });
    expect(cleanTaskTitle(legacy)).toBe("Background job");
    expect(cleanTaskTitle(task({ id: "c2", title: "Run tests", responderOwned: true }))).toBe("Run tests");
    expect(cleanTaskTitle({ ...legacy, responderOwned: false })).toBe("Responder · npm test");
  });

  it("shows the stored title of a legacy Responder row instead of a generic label", () => {
    expect(cleanTaskTitle(task({ id: "c1", title: "Responder · Run local CI checks", responderOwned: true }))).toBe("Run local CI checks");
    expect(cleanTaskTitle(task({ id: "c2", title: "Responder · Verify pull request CI", responderOwned: true }))).toBe("Verify pull request CI");
    expect(cleanTaskTitle(task({ id: "c3", title: "Responder ·", responderOwned: true }))).toBe("Background job");
    expect(cleanTaskTitle(task({ id: "c4", title: "Responder · npm test -- --reporter=verbose", responderOwned: true }))).toBe("Background job");
  });

  it.each<{ state: TaskState; glyph: string }>([
    { state: "done", glyph: "✓" },
    { state: "failed", glyph: "✗" },
  ])("keeps the $state lifecycle glyph", ({ state, glyph }) => {
    expect(taskGlyph(task({ id: "c3", state, responderOwned: true }))).toBe(glyph);
  });

  it("hides only the failed responder glyph in the task pane", () => {
    expect(taskPaneGlyph(task({ id: "c3", state: "failed", responderOwned: true }))).toBe("");
    expect(taskPaneGlyph(task({ id: "c4", state: "done", responderOwned: true }))).toBe("✓");
    expect(taskPaneGlyph(task({ id: "t1", state: "failed" }))).toBe("✗");
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
