import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type Dispatch, type Ref, type RefObject, type SetStateAction } from "react";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { PlanTask, SessionPlan } from "../../../store/plan.js";
import {
  moveTaskSelection,
  reconcileTaskDisclosure,
  setAllTaskDisclosure,
  setTaskDisclosure,
  taskDisclosureSummary,
  type TaskDisclosureState,
} from "../../../ui-core/rendering/task-disclosure.js";
import type { PlanInteractionPort } from "./plan-interaction.js";
import { orderPlanTasksForDisplay } from "../../../ui-core/rendering/plan-view.js";

export interface TaskDisclosureBinding {
  readonly state: TaskDisclosureState;
  readonly tasks: readonly PlanTask[];
  readonly setState: Dispatch<SetStateAction<TaskDisclosureState>>;
}

export function useTaskDisclosureBinding(plan: SessionPlan | undefined, inherited?: TaskDisclosureBinding): TaskDisclosureBinding {
  const tasks = useMemo(() => inherited?.tasks ?? (plan ? orderPlanTasksForDisplay(plan.tasks) : []), [inherited?.tasks, plan?.tasks]);
  const [stored, setStored] = useState<TaskDisclosureState>(() => reconcileTaskDisclosure({ planKey: "", selectedId: undefined, expanded: new Set() }, plan, tasks));
  const state = inherited?.state ?? reconcileTaskDisclosure(stored, plan, tasks);
  if (!inherited && state !== stored) setStored(state);
  const setState = inherited?.setState ?? setStored;
  return useMemo(() => ({ state, tasks, setState }), [state, tasks, setState]);
}

function taskHeaderBounds(scroll: ScrollBoxRenderable, taskId: string): { top: number; height: number } | undefined {
  const header = scroll.content.findDescendantById(`plan-task-${taskId}-header`);
  if (!header) return undefined;
  let top = 0;
  let current: Renderable | null = header;
  while (current && current !== scroll.content) {
    top += current.getLayoutNode().getComputedTop();
    current = current.parent;
  }
  return { top, height: header.getLayoutNode().getComputedHeight() };
}

export function revealTaskHeader(scroll: ScrollBoxRenderable | null, taskId: string): void {
  if (!scroll) return;
  const header = taskHeaderBounds(scroll, taskId);
  if (!header) return;
  const bottom = header.top + Math.min(header.height, scroll.viewport.height);
  if (header.top < scroll.scrollTop) scroll.scrollTo(header.top);
  else if (bottom > scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(bottom - scroll.viewport.height);
}

export function useTaskDisclosure(
  plan: SessionPlan | undefined,
  scrollRef: RefObject<ScrollBoxRenderable | null>,
  interactionRef: Ref<PlanInteractionPort> | undefined,
  inherited?: TaskDisclosureBinding,
) {
  const { state, tasks, setState } = useTaskDisclosureBinding(plan, inherited);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || state.expanded.size > 0) return;
    let previous = scroll.scrollTop;
    let aligning = false;
    const alignTitle = (): void => {
      const position = scroll.scrollTop;
      const down = position >= previous;
      previous = position;
      if (aligning || scroll.viewport.height <= 0) return;
      const headers = tasks.flatMap((task) => {
        const header = taskHeaderBounds(scroll, task.id);
        return header && header.height > 0 ? [header] : [];
      });
      const bottom = position + scroll.viewport.height;
      if (headers.some((header) => header.height <= scroll.viewport.height
        ? header.top >= position && header.top + header.height <= bottom
        : header.top < bottom && header.top + header.height > position)) return;
      const target = down ? headers.find((header) => header.top >= position) ?? headers.at(-1)
        : [...headers].reverse().find((header) => header.top < position) ?? headers[0];
      if (!target) return;
      aligning = true;
      scroll.scrollTo(target.top);
      previous = scroll.scrollTop;
      aligning = false;
    };
    scroll.verticalScrollBar.on("change", alignTitle);
    scroll.viewport.on("resized", alignTitle);
    scroll.content.on("resized", alignTitle);
    alignTitle();
    return () => {
      scroll.verticalScrollBar.off("change", alignTitle);
      scroll.viewport.off("resized", alignTitle);
      scroll.content.off("resized", alignTitle);
    };
  }, [scrollRef, tasks, state.expanded.size]);
  const update = useCallback((operation: (current: TaskDisclosureState) => TaskDisclosureState, keyboardFocusVisible: boolean): void => {
    setState((current) => {
      const next = operation(reconcileTaskDisclosure(current, plan, tasks));
      return next.keyboardFocusVisible === keyboardFocusVisible ? next : { ...next, keyboardFocusVisible };
    });
  }, [plan, tasks, setState]);
  const toggleTask = useCallback((id: string): void => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) update((current) => setTaskDisclosure(current, task), false);
  }, [tasks, update]);
  const setAllExpanded = useCallback((expanded: boolean, keyboardFocusVisible = false): void => {
    update((current) => setAllTaskDisclosure(current, tasks, expanded), keyboardFocusVisible);
  }, [tasks, update]);
  const hideKeyboardFocus = useCallback((): void => update((current) => current, false), [update]);

  useImperativeHandle(interactionRef, () => ({
    moveSelection(delta) {
      update((current) => moveTaskSelection(current, tasks, delta), true);
    },
    setSelectedExpanded(expanded) {
      update((current) => {
        const task = tasks.find((candidate) => candidate.id === current.selectedId);
        return task ? setTaskDisclosure(current, task, expanded) : current;
      }, true);
    },
    setAllExpanded(expanded) {
      setAllExpanded(expanded, true);
    },
    page(delta) {
      update((current) => current, true);
      const scroll = scrollRef.current;
      if (scroll) scroll.scrollBy(delta * Math.max(1, scroll.viewport.height - 2));
    },
  }), [scrollRef, setAllExpanded, tasks, update]);

  return {
    tasks,
    expanded: state.expanded,
    selectedId: state.selectedId,
    keyboardFocusVisible: state.keyboardFocusVisible === true,
    summary: taskDisclosureSummary(tasks, state.expanded),
    toggleTask,
    setAllExpanded,
    hideKeyboardFocus,
  };
}
