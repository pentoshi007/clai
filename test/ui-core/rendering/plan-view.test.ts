import { describe, expect, it } from "vitest";
import type { SessionPlan } from "../../../src/store/plan.js";
import {
  activeTaskId,
  formatPlanPagerDocument,
  planStatusChip,
  progressBar,
  progressView,
  STATUS_LABEL,
  taskLabel,
  taskStateColor,
  TASK_GLYPH,
} from "../../../src/ui-core/rendering/plan-view.js";

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

  it("maps task states to high-contrast color tokens", () => {
    // Pending must not use washed muted slate; active keeps yellow; done bright green.
    expect(taskStateColor("pending")).toBe("foreground");
    expect(taskStateColor("in_progress")).toBe("activity");
    expect(taskStateColor("done")).toBe("success");
    expect(taskStateColor("failed")).toBe("diffDel");
    expect(taskStateColor("skipped")).toBe("muted");
  });

  it("builds a compact progress bar and plan status chips", () => {
    expect(progressBar(3, 8, 8)).toBe("███░░░░░");
    expect(progressBar(0, 0, 6)).toBe("░░░░░░");
    expect(progressBar(4, 4, 4)).toBe("████");
    expect(planStatusChip("in_progress")).toBe("ACTIVE");
    expect(planStatusChip("completed")).toBe("DONE");
  });

  it("finds the first pending/in-progress task as active (PLAN-002)", () => {
    expect(activeTaskId(plan())).toBe("t2");
    expect(activeTaskId(plan({ tasks: [{ id: "t1", title: "one", state: "done" }] }))).toBeUndefined();
  });

  it("formats a full pager document with approach + tasks", () => {
    const doc = formatPlanPagerDocument(plan());
    expect(doc).toContain("# Ship the feature");
    expect(doc).toContain("## Approach");
    expect(doc).toMatch(/## Tasks/);
    expect(doc).toContain("one");
    expect(doc).toContain("two");
    expect(doc).toMatch(/done/);
    expect(doc).toMatch(/active/);
    // Markdown table + horizontal rule
    expect(doc).toContain("| # | State | Task | Id |");
    expect(doc).toContain("---");
    expect(doc).not.toMatch(/\x1b\[/); // no ANSI/chalk
  });

  it("strips redundant t1: prefixes and includes notes", () => {
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
    expect(doc).toMatch(/done/);
    expect(doc).toMatch(/failed/);
    expect(doc).toContain("long note");
    expect(doc).toContain("---");
  });
});
