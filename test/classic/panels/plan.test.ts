import { describe, expect, it } from "vitest";
import type { PlanTask } from "../../../src/store/plan.js";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import { planKey, planView, PLAN_INITIAL_STATE } from "../../../src/classic/panels/plan-panel.js";
import { asciiInk, createHarness, ink, plan, rowsOf } from "./harness.js";

function task(overrides: Partial<PlanTask> & Pick<PlanTask, "id" | "title" | "state">): PlanTask {
  return { ...overrides };
}

const TASKS: PlanTask[] = [
  task({ id: "t1", title: "Read the route handler", state: "done" }),
  task({ id: "t2", title: "Add limit/offset to the query layer", state: "in_progress", responderOwned: true }),
  task({ id: "t3", title: "Update the response shape", state: "pending" }),
  task({ id: "t4", title: "Add tests", state: "pending" }),
];

const PLAN = plan(TASKS);

function render(state = PLAN_INITIAL_STATE, focused = true, theme = ink, rows = 9) {
  const frame = planView({ ink: theme, columns: 80, rows, plan: PLAN, state, focused });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

describe("plan rows", () => {
  it("shows the progress bar and the done counter", () => {
    const { frame, rows } = render();
    expect(frame.title).toBe("Tasks");
    expect(frame.borderColor).toBe("border");
    expect(frame.counter).toBe("1/3 done");
    expect(rows[1]).toContain("████░░░░░░░░");
    expect(rows[1]).toContain("33%");
  });

  it("uses the shared task glyphs and owner chip row", () => {
    const { rows } = render();
    const body = rows.join("\n");
    expect(body).toContain("✓ Read the route handler");
    expect(body).toContain("⟳ Add limit/offset to the query layer");
    expect(body).toContain("RESPONDER · RUNNING");
    expect(body).toContain("○ Add tests");
  });

  it("downgrades the bar and glyphs without Unicode", () => {
    const { rows } = render(PLAN_INITIAL_STATE, true, asciiInk);
    expect(rows[1]).toContain("####........");
    expect(rows.join("\n")).toContain("v Read the route handler");
    expect(rows.join("\n")).not.toContain("⟳");
  });

  it("lists its own hints", () => {
    expect(render().frame.hints).toEqual(["^H hide", "^P detail", "▲▼ task"]);
  });

  it("wraps long titles instead of ellipsizing them", () => {
    const long = plan([task({ id: "x", title: "z".repeat(200), state: "pending" })]);
    const frame = planView({
      ink,
      columns: 60,
      rows: 12,
      plan: long,
      state: PLAN_INITIAL_STATE,
      focused: false,
    });
    const body = rowsOf(panelFrameRows(frame).rows).join("");
    expect(body).not.toContain("…");
  });
});

describe("plan keys", () => {
  it("moves the focused task only when the plan region has focus", () => {
    const moved = planKey({ state: PLAN_INITIAL_STATE, chord: "down", plan: PLAN, rows: 9, focused: true });
    expect(moved.state.cursor).toBe(1);
    const ignored = planKey({ state: PLAN_INITIAL_STATE, chord: "down", plan: PLAN, rows: 9, focused: false });
    expect(ignored.handled).toBe(false);
  });

  it("opens the shared plan document in the pager on ctrl+p", () => {
    const harness = createHarness();
    harness.plan = PLAN;
    expect(harness.panels.handlePlanKey("ctrl+p", false)).toBe(true);
    const state = harness.overlay.getState();
    expect(state.kind).toBe("pager");
    if (state.kind !== "pager") throw new Error("expected pager");
    expect(state.title).toBe("Plan");
    expect(state.markdown).toBe("force");
    expect(state.body).toContain("Read the route handler");
  });

  it("hides the pane on ctrl+h", () => {
    const harness = createHarness();
    harness.plan = PLAN;
    expect(harness.panels.handlePlanKey("ctrl+h", true)).toBe(true);
    expect(harness.hidden).toHaveLength(1);
  });

  it("does nothing without a plan", () => {
    const harness = createHarness();
    expect(harness.panels.handlePlanKey("ctrl+p", true)).toBe(false);
  });
});
