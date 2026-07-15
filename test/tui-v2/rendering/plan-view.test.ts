import { describe, expect, it } from "vitest";
import type { SessionPlan } from "../../../src/store/plan.js";
import {
  activeTaskId,
  formatPlanPagerDocument,
  progressView,
  STATUS_LABEL,
  taskLabel,
  TASK_GLYPH,
} from "../../../src/tui-v2/rendering/plan-view.js";

function plan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    sessionId: "s1",
    goal: "Ship the feature",
    detail: "## Plan\n...",
    tasks: [
      { id: "t1", title: "one", state: "done" },
      { id: "t2", title: "two", state: "in_progress" },
      { id: "t3", title: "three", state: "pending" },
    ],
    status: "approved",
    kind: "coding",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("plan-view rendering helpers (PLAN-001)", () => {
  it("computes progress from done vs total tasks", () => {
    const view = progressView(plan());
    expect(view.done).toBe(1);
    expect(view.total).toBe(3);
    expect(view.label).toBe("1/3 tasks");
  });

  it("reports no-tasks-yet distinctly from zero progress", () => {
    expect(progressView(plan({ tasks: [] })).label).toBe("no tasks");
  });

  it("labels a task with its state glyph and id", () => {
    expect(taskLabel({ id: "t1", title: "one", state: "done" })).toBe(
      `${TASK_GLYPH.done} t1  one`,
    );
    expect(taskLabel({ id: "t2", title: "two", state: "failed" })).toBe(
      `${TASK_GLYPH.failed} t2  two`,
    );
  });

  it("has a status label for every plan status", () => {
    for (const status of Object.keys(STATUS_LABEL) as Array<keyof typeof STATUS_LABEL>) {
      expect(STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
  });

  it("finds the first pending/in-progress task as active (PLAN-002)", () => {
    expect(activeTaskId(plan())).toBe("t2");
    expect(activeTaskId(plan({ tasks: [{ id: "t1", title: "one", state: "done" }] }))).toBeUndefined();
  });

  it("formats a full pager document with approach + tasks", () => {
    const doc = formatPlanPagerDocument(plan());
    expect(doc).toContain("Ship the feature");
    expect(doc).toContain("Approach");
    expect(doc).toContain("Tasks");
    expect(doc).toContain("one");
    expect(doc).toContain("two");
    expect(doc).toContain("[done]");
    expect(doc).toContain("[active]");
    // Tasks separated by horizontal rules
    expect(doc.split("─").length).toBeGreaterThan(3);
    expect(doc).not.toMatch(/\x1b\[/); // no ANSI/chalk
  });

  it("strips redundant t1: prefixes and wraps long notes cleanly", () => {
    const doc = formatPlanPagerDocument(
      plan({
        tasks: [
          {
            id: "t1",
            title: "t1: Download full OpenAPI spec and extract endpoints",
            state: "done",
            note: "A long note that should soft-wrap without looking like free-floating prose under a bare status word.",
          },
          {
            id: "t2",
            title: "Authenticate and obtain bearer token",
            state: "failed",
            note: "Cannot authenticate without practice_id.",
          },
        ],
      }),
    );
    expect(doc).toContain("Download full OpenAPI");
    expect(doc).not.toMatch(/✓\s+1\.\s+t1:/);
    expect(doc).toContain("[done]");
    expect(doc).toContain("[failed]");
    expect(doc).toContain("note");
    expect(doc).toMatch(/─{10,}/);
  });
});
