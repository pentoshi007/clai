import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import type { PlanTask, SessionPlan, TaskState } from "../../src/store/plan.js";
import { findBunExecutable } from "../../src/os/bun-runtime.js";
import { orderPlanTasksForDisplay, wrapPlanText } from "../../src/ui-core/rendering/plan-view.js";
import { hasTaskDetails, moveTaskSelection, reconcileTaskDisclosure, setAllTaskDisclosure, setTaskDisclosure, taskDetailText, taskDisclosureSummary, wrapTaskDisclosureTitle, type TaskDisclosureState } from "../../src/ui-core/rendering/task-disclosure.js";
import { ActionRouter } from "../../src/ui-core/actions/action-router.js";
import { validateKeymap } from "../../src/ui-core/actions/keymap.js";
import { formatShortcutsReference } from "../../src/ui-core/actions/format-shortcuts.js";
import { handlePlanInteraction, OPEN_TUI_KEYMAP, resolvePlanInteraction, type PlanInteractionPort } from "../../src/tui-v2/components/plan/plan-interaction.js";

function task(id: string, overrides: Partial<PlanTask> = {}): PlanTask {
  return { id, title: `Task ${id}`, state: "pending", ...overrides };
}
function plan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return { sessionId: "s1", goal: "Task disclosure", detail: "", kind: "ui", status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tasks: [task("t1", { state: "in_progress", note: "Findings" }), task("t2", { note: "Required proof" }), task("t3")], ...overrides };
}
function initial(source: SessionPlan = plan()): TaskDisclosureState {
  return reconcileTaskDisclosure({ planKey: "", expanded: new Set(), selectedId: undefined }, source, orderPlanTasksForDisplay(source.tasks));
}

describe("OpenTUI task disclosure", () => {
  it("starts collapsed without changing the durable plan", () => {
    const source = plan();
    const before = JSON.stringify(source);
    expect(initial(source).expanded.size).toBe(0);
    expect(initial(source).selectedId).toBe("t1");
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each<TaskState>(["pending", "in_progress", "done", "failed", "skipped"])("keeps details available for %s tasks", (state) => {
    const source = task("t1", { state, note: "Findings", acceptanceCriteria: "Acceptance" });
    expect(taskDetailText(source)).toBe("Findings");
    expect(setTaskDisclosure(initial(), source).expanded.has("t1")).toBe(true);
  });

  it("treats empty details as non-interactive", () => {
    const source = task("t3", { note: " \n ", acceptanceCriteria: "\t", evidence: { successWorkCount: 0 } });
    const state = initial();
    expect(hasTaskDetails(source)).toBe(false);
    expect(taskDetailText(source)).toBe("");
    expect(setTaskDisclosure(state, source)).toBe(state);
  });

  it("only discloses the original note and job text without introducing new fields", () => {
    const metadata = task("t3", { acceptanceCriteria: "Acceptance", dependencies: ["t1"], resourceLocks: ["database"], supersededBy: "t4", evidence: { successWorkCount: 3, lastOkTool: "fs.read" } });
    expect(taskDetailText(metadata)).toBe("");
    expect(hasTaskDetails(metadata)).toBe(false);
    expect(taskDetailText({ ...metadata, jobId: "job-1" })).toBe("job=job-1");
    expect(taskDetailText({ ...metadata, processId: 123 })).toBe("");
    expect(taskDetailText({ ...metadata, note: "  Findings\ncontinued  ", jobId: "job-1", processId: 123 })).toBe("job=job-1 pid=123 · Findings\ncontinued");
  });

  it("positions the disclosure after the final title segment without reserving a right column", () => {
    expect(wrapTaskDisclosureTitle("Short title", 48, true)).toEqual(["Short title"]);
    expect(wrapTaskDisclosureTitle("one two three", 14, true)).toEqual(["one two", "three"]);
    expect(wrapTaskDisclosureTitle("Verify the responsive controls", 17, true)).toEqual(["Verify the", "responsive", "controls"]);
    expect(wrapTaskDisclosureTitle("Verify the responsive controls", 16, true)).toEqual(["Verify the", "responsive", "controls"]);
    expect(wrapTaskDisclosureTitle("123456789", 14, true)).toEqual(["1234567", "89"]);
    for (const width of [14, 18, 30, 48]) {
      for (const title of ["Inspect the task contracts", "检查 👩🏽‍💻 regression e\u0301", "long_identifier_without_spaces_0123456789"]) {
        const lines = wrapTaskDisclosureTitle(title, width, true);
        expect(lines.join("").replace(/\s/g, "")).toBe(title.replace(/\s/g, ""));
        expect(lines.every((line) => line.trim().length > 0)).toBe(true);
        expect(stringWidth(lines[lines.length - 1]!) + 7).toBeLessThanOrEqual(width);
        expect(wrapTaskDisclosureTitle(title, width, false)).toEqual(wrapPlanText(title, width - 5));
      }
    }
  });

  it("supports individual, mixed, all-expanded and all-collapsed states", () => {
    const source = plan();
    const one = setTaskDisclosure(initial(source), source.tasks[0]!);
    expect(taskDisclosureSummary(source.tasks, one.expanded)).toEqual({ total: 2, expanded: 1 });
    const all = setAllTaskDisclosure(one, source.tasks, true);
    expect(taskDisclosureSummary(source.tasks, all.expanded)).toEqual({ total: 2, expanded: 2 });
    expect(all.expanded.has("t3")).toBe(false);
    const mixed = setTaskDisclosure(all, source.tasks[1]!, false);
    expect([...mixed.expanded]).toEqual(["t1"]);
    expect(setAllTaskDisclosure(mixed, source.tasks, false).expanded.size).toBe(0);
    expect(setTaskDisclosure(one, source.tasks[0]!).expanded.size).toBe(0);
  });

  it("retains stable IDs through live updates and reordering, with new tasks collapsed", () => {
    const source = plan();
    const opened = setAllTaskDisclosure(initial(source), source.tasks, true);
    const updated = plan({ updatedAt: "2026-01-01T00:00:01Z", tasks: [source.tasks[1]!, task("t4", { note: "New findings" }), source.tasks[0]!, source.tasks[2]!] });
    const next = reconcileTaskDisclosure(opened, updated, updated.tasks);
    expect(next).toBe(opened);
    expect(next.expanded.has("t4")).toBe(false);
    expect(taskDisclosureSummary(updated.tasks, next.expanded)).toEqual({ total: 3, expanded: 2 });
  });

  it("prunes removed tasks and disappearing details", () => {
    const source = plan();
    const opened = setAllTaskDisclosure(initial(source), source.tasks, true);
    const updated = plan({ tasks: [task("t1"), source.tasks[2]!] });
    const next = reconcileTaskDisclosure(opened, updated, updated.tasks);
    expect(next.expanded.size).toBe(0);
    const reused = plan({ tasks: [task("t2", { note: "Different task" })] });
    expect(reconcileTaskDisclosure(next, reused, reused.tasks).expanded.size).toBe(0);
  });

  it("resets disclosure when the plan, session or loaded history changes", () => {
    const source = plan();
    const opened = setAllTaskDisclosure(initial(source), source.tasks, true);
    for (const updated of [plan({ sessionId: "s2" }), plan({ createdAt: "2026-01-02T00:00:00Z" })]) {
      expect(reconcileTaskDisclosure(opened, updated, updated.tasks).expanded.size).toBe(0);
    }
    const cleared = reconcileTaskDisclosure(opened, undefined, []);
    expect(cleared.selectedId).toBeUndefined();
    expect(reconcileTaskDisclosure(cleared, source, source.tasks).expanded.size).toBe(0);
  });

  it("does not fold child tasks into the parent disclosure", () => {
    const source = plan({ tasks: [task("c1", { parentTaskId: "t1", responderOwned: true, note: "Child proof", jobId: "job-1", processId: 123 }), task("t1", { note: "Parent proof" })] });
    const tasks = orderPlanTasksForDisplay(source.tasks);
    expect(tasks.map((value) => value.id)).toEqual(["t1", "c1"]);
    const all = setAllTaskDisclosure(initial(source), tasks, true);
    const collapsedParent = setTaskDisclosure(all, tasks[0]!, false);
    expect(collapsedParent.expanded.has("c1")).toBe(true);
    expect(taskDetailText(tasks[1]!)).toBe("job=job-1 pid=123 · Child proof");
  });

  it("keeps keyboard selection valid at list boundaries and for empty lists", () => {
    const source = plan();
    const state = initial(source);
    expect(moveTaskSelection(state, source.tasks, -1).selectedId).toBe("t1");
    expect(moveTaskSelection(state, source.tasks, 1).selectedId).toBe("t2");
    expect(moveTaskSelection(state, source.tasks, 100).selectedId).toBe("t3");
    expect(moveTaskSelection(state, [], 1)).toBe(state);
  });

  it("routes only OpenTUI plan keys and leaves classic/composer/pager bindings intact", () => {
    expect(validateKeymap(OPEN_TUI_KEYMAP)).toEqual([]);
    const router = new ActionRouter(OPEN_TUI_KEYMAP);
    expect(router.resolve("enter", "plan")).toBe("plan.toggle-task");
    expect(router.resolve("enter", "composer")).toBe("editor.submit");
    expect(router.resolve("e", "composer")).toBeUndefined();
    expect(router.resolve("c", "pager")).toBe("pager.copy");
    expect(router.resolve("ctrl+p", "plan")).toBe("plan.toggle-detail");
    expect(new ActionRouter().resolve("enter", "plan")).toBe("plan.toggle-detail");
    expect(formatShortcutsReference(OPEN_TUI_KEYMAP)).toContain("Expand all task details");
    expect(resolvePlanInteraction("e")).toBe("plan.expand-all");
  });

  it("dispatches the full pane action contract without consuming unrelated actions", () => {
    const calls: string[] = [];
    const port: PlanInteractionPort = {
      moveSelection: (delta) => { calls.push(`move:${delta}`); },
      setSelectedExpanded: (expanded) => { calls.push(`selected:${expanded}`); },
      setAllExpanded: (expanded) => { calls.push(`all:${expanded}`); },
      page: (delta) => { calls.push(`page:${delta}`); },
    };
    for (const action of ["plan.next-task", "plan.prev-task", "plan.toggle-task", "plan.expand-task", "plan.collapse-task", "plan.expand-all", "plan.collapse-all", "plan.page-up", "plan.page-down"] as const) expect(handlePlanInteraction(action, port)).toBe(true);
    expect(calls).toEqual(["move:1", "move:-1", "selected:undefined", "selected:true", "selected:false", "all:true", "all:false", "page:-1", "page:1"]);
    expect(handlePlanInteraction("plan.expand-all", null)).toBe(false);
    expect(handlePlanInteraction("plan.toggle-detail", port)).toBe(false);
  });

  it("wraps by terminal cells without splitting graphemes or leaking control sequences", () => {
    const text = "检查 👩🏽‍💻 regression e\u0301";
    for (const width of [2, 5, 8, 17]) {
      const lines = wrapPlanText(text, width);
      expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
      expect(lines.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    }
    expect(wrapPlanText("one two three four", 8)).toEqual(["one two", "three", "four"]);
    expect(wrapPlanText("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapPlanText("Inspect the task contracts", 11)).toEqual(["Inspect the", "task", "contracts"]);
    expect(wrapPlanText("safe\u001b[31m text\u001b[0m", 20)).toEqual(["safe text"]);
    expect(wrapPlanText(" ", 0)).toEqual([""]);
    expect(wrapPlanText("abc", Number.NaN)).toEqual(["a", "b", "c"]);
    expect(wrapPlanText("检查", 1)).toEqual(["…", "…"]);
  });
});

const bun = findBunExecutable();
for (const [name, proof] of [
  ["plan-disclosure", "Native task disclosure passed"],
  ["plan-disclosure-app", "Native task disclosure passed"],
  ["plan-scroll", "Native task scrolling passed"],
  ["plan-viewport", "Native task viewport passed"],
] as const) {
  it.skipIf(!bun)(`proves ${name} with the native OpenTUI renderer`, () => {
    const result = spawnSync(bun!, ["run", fileURLToPath(new URL(`./${name}.native.ts`, import.meta.url))], { encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CLAI_NO_UPDATE_CHECK: "1", CLAI_DISABLE_KEYCHAIN: "1" } });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(proof);
  }, 50000);
}
