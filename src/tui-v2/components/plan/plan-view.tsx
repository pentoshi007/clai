/** @jsxImportSource @opentui/react */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { countRender } from "../../perf/render-counters.js";
import { TextAttributes, type BoxRenderable, type MouseEvent, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { startSnappedSelection } from "../transcript/selection-snap.js";
import { patchOpenTuiSelection } from "../../bootstrap/patch-opentui-selection.js";

patchOpenTuiSelection();
import type { PlanTask, SessionPlan } from "../../../store/plan.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import {
  activeTaskId,
  cleanTaskTitle,
  planStatusChip,
  planStatusColor,
  progressBar,
  progressView,
  taskGlyph,
  taskRowColor,
  taskOwnerChip,
  wrapPlanText,
  type PlanColorToken,
} from "../../../ui-core/rendering/plan-view.js";
import { discardPlan, implementPlan } from "../../../ui-core/plan/plan-lifecycle.js";
import { hasTaskDetails, taskDetailText, wrapTaskDisclosureTitle, TASK_DISCLOSURE_BUTTON_WIDTH } from "../../../ui-core/rendering/task-disclosure.js";
import { revealTaskHeader, useTaskDisclosure, type TaskDisclosureBinding } from "./use-task-disclosure.js";
import type { PlanInteractionPort } from "./plan-interaction.js";

export interface PlanViewProps {
  readonly theme: Theme;
  readonly plan: SessionPlan | undefined;
  readonly services: AppServices;
  readonly onHide: () => void;
  readonly width?: number | undefined;
  readonly focused?: boolean | undefined;
  readonly interactionRef?: Ref<PlanInteractionPort> | undefined;
  readonly disclosureBinding?: TaskDisclosureBinding | undefined;
}

function tokenFg(theme: Theme, token: PlanColorToken): string {
  return theme[token];
}

function Chip(props: {
  label: string;
  fg: string;
  bg: string;
  theme: Theme;
}): ReactNode {
  const { label, fg, bg } = props;
  return (
    <text selectable={false}
      content={` ${label} `}
      style={{
        fg,
        bg,
        height: 1,
        flexShrink: 0,
        attributes: TextAttributes.BOLD,
      }}
    />
  );
}

function ActionChip(props: {
  id: string;
  label: string;
  fg: string;
  bg: string;
  onClick: () => void;
}): ReactNode {
  const { id, label, fg, bg, onClick } = props;
  return (
    <box
      id={id}
      onMouseDown={(event: MouseEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      style={{ flexShrink: 0 }}
    >
      <text selectable={false}
        content={` ${label} `}
        style={{
          fg,
          bg,
          height: 1,
          attributes: TextAttributes.BOLD,
        }}
      />
    </box>
  );
}

function PlanViewImpl(props: PlanViewProps): ReactNode {
  countRender("PlanView");
  const { theme, plan, services, onHide, width: widthProp, interactionRef } = props;
  const focused = props.focused ?? services.focus.activeContext() === "plan";
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const paneRef = useRef<BoxRenderable>(null);
  const renderer = useRenderer();
  const activeId = plan ? activeTaskId(plan) : undefined;
  const paneWidth = widthProp ?? 36;
  const headerWidth = Math.max(1, paneWidth - 4);
  const taskWidth = Math.max(1, paneWidth - 3);
  const disclosure = useTaskDisclosure(plan, scrollRef, interactionRef, props.disclosureBinding);
  const displayTasks = disclosure.tasks;
  const previousTargets = useRef<{ selectedId: string | undefined; activeId: string | undefined }>({ selectedId: undefined, activeId: undefined });

  useEffect(() => {
    const previous = previousTargets.current;
    previousTargets.current = { selectedId: disclosure.selectedId, activeId };
    const target = focused ? disclosure.selectedId : activeId;
    const priorTarget = focused ? previous.selectedId : previous.activeId;
    if (target && target !== priorTarget) revealTaskHeader(scrollRef.current, target);
  }, [focused, disclosure.selectedId, activeId]);

  const toggleTask = useCallback((id: string): void => {
    if (services.overlay.isOpen()) return;
    services.focus.focusRegion("plan");
    disclosure.toggleTask(id);
  }, [services.focus, services.overlay, disclosure.toggleTask]);
  function trapWheel(event: MouseEvent): void {
    if (!event.scroll) return;
    event.stopPropagation();
    disclosure.hideKeyboardFocus();
    services.focus.focusRegion("plan");
  }

  function onPaneMouseDown(event: MouseEvent): void {
    event.preventDefault();
    const pane = paneRef.current;
    if (!pane) return;
    const scroll = scrollRef.current;
    const regions = scroll
      ? [
          { root: pane.findDescendantById("plan-header") as Renderable | undefined },
          { root: scroll as Renderable, viewport: scroll.viewport },
        ]
      : [{ root: pane as Renderable }];
    startSnappedSelection<Renderable>(renderer, event, regions);
  }

  return (
    <box
      id="plan-pane"
      ref={paneRef}
      style={{ flexDirection: "column", flexGrow: 1, width: "100%", height: "100%", backgroundColor: theme.statusBackground }}
      onMouseDown={onPaneMouseDown}
      onMouseScroll={trapWheel}
    >
      {!plan ? (
        <box style={{ alignItems: "flex-end", paddingTop: 1, paddingRight: 1, flexShrink: 0 }}>
          <ActionChip id="plan-hide" label="Hide" fg={theme.foreground} bg={theme.chip} onClick={onHide} />
        </box>
      ) : null}
      {plan ? (
        <>
          <PlanHeader theme={theme} plan={plan} services={services} width={headerWidth} onHide={onHide} />
          <scrollbox
            id="plan-tasks"
            ref={scrollRef}
            stickyScroll={false}
            viewportCulling
            scrollY
            scrollX={false}
            scrollbarOptions={{ visible: false, showArrows: false }}
            onMouseScroll={trapWheel}
            style={{ flexGrow: 1, flexShrink: 1, width: "100%", minHeight: 1, backgroundColor: theme.statusBackground, paddingLeft: 1, paddingRight: 1 }}
          >
            {displayTasks.map((task, index) => (
              <TaskRow
                key={task.id}
                task={task}
                theme={theme}
                width={taskWidth}
                active={task.id === activeId}
                selected={focused && disclosure.keyboardFocusVisible && task.id === disclosure.selectedId}
                expanded={disclosure.expanded.has(task.id)}
                index={index}
                onToggle={toggleTask}
              />
            ))}
            {displayTasks.length === 0 ? <text selectable content="No tasks yet" style={{ fg: theme.muted, height: 1 }} /> : null}
          </scrollbox>
        </>
      ) : (
        <box style={{ flexDirection: "column", flexGrow: 1, justifyContent: "center", alignItems: "center", paddingLeft: 1, paddingRight: 1 }}>
          <text selectable={false} content="◇" style={{ fg: theme.magenta, height: 1, attributes: TextAttributes.BOLD }} />
          <text selectable content="No tasks yet" style={{ fg: theme.foreground, height: 1, attributes: TextAttributes.BOLD, marginTop: 1 }} />
          <text selectable content="Plan a multi-step job," style={{ fg: theme.muted, height: 1, marginTop: 1 }} />
          <text selectable content="then /implement." style={{ fg: theme.muted, height: 1 }} />
          <text selectable content="Ctrl+H toggle · Ctrl+P detail" style={{ fg: theme.cyan, height: 1, marginTop: 1 }} />
        </box>
      )}
    </box>
  );
}

function PlanHeader(props: {
  theme: Theme;
  plan: SessionPlan;
  services: AppServices;
  width: number;
  onHide: () => void;
}): ReactNode {
  const { theme, plan, services, width, onHide } = props;
  const progress = progressView(plan);
  const statusFg = tokenFg(theme, planStatusColor(plan.status));
  const statusBg = plan.status === "completed" ? theme.diffAddBg : plan.status === "draft" ? theme.chipTeal : theme.chip;
  const countLabel = progress.total === 0 ? "0 tasks" : `${progress.done}/${progress.total}`;
  const controlsWidth = 6;
  const inline = width >= controlsWidth + countLabel.length + 7;
  const barWidth = Math.max(4, Math.min(14, width - countLabel.length - (inline ? controlsWidth + 3 : 1)));
  const controls = <ActionChip id="plan-hide" label="Hide" fg={theme.foreground} bg={theme.chip} onClick={onHide} />;

  return (
    <box id="plan-header" style={{ flexDirection: "column", width: "100%", flexShrink: 0, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
      {wrapPlanText(plan.goal, width).map((line, index) => (
        <text selectable key={`goal-${index}`} content={line} style={{ fg: theme.foreground, height: 1, attributes: TextAttributes.BOLD }} />
      ))}
      <box style={{ flexDirection: "row", width: "100%", height: 1, marginTop: 1, flexShrink: 0, gap: 1 }}>
        <Chip label={planStatusChip(plan.status)} fg={plan.status === "draft" ? theme.white : theme.foreground} bg={statusBg} theme={theme} />
        <text selectable content={wrapPlanText(plan.kind || "general", Math.max(1, width - planStatusChip(plan.status).length - 3))[0] ?? ""} style={{ fg: theme.muted, height: 1, flexShrink: 1 }} />
      </box>
      <box id="plan-progress" style={{ flexDirection: "row", width: "100%", height: 1, marginTop: 1, alignItems: "center", flexShrink: 0, gap: 1 }}>
        <text selectable={false} content={progressBar(progress.done, progress.total, barWidth)} style={{ fg: progress.done === progress.total && progress.total > 0 ? theme.success : theme.cyan, height: 1, flexShrink: 0 }} />
        <text selectable content={countLabel} style={{ fg: statusFg, height: 1, flexShrink: 0, attributes: TextAttributes.BOLD }} />
        {inline ? <box style={{ flexGrow: 1 }} /> : null}
        {inline ? controls : null}
      </box>
      {!inline ? <box style={{ flexShrink: 0, marginTop: 1 }}>{controls}</box> : null}
      {plan.status === "draft" ? (
        <box style={{ flexDirection: width >= 21 ? "row" : "column", width: "100%", marginTop: 1, flexShrink: 0, gap: width >= 21 ? 1 : 0 }}>
          <ActionChip id="plan-implement" label="Implement" fg={theme.foreground} bg={theme.diffAddBg} onClick={() => void implementPlan(services)} />
          <ActionChip id="plan-discard" label="Discard" fg={theme.foreground} bg={theme.chip} onClick={() => void discardPlan(services)} />
        </box>
      ) : null}
      <text selectable={false} content={"─".repeat(width)} style={{ fg: theme.border, height: 1, marginTop: 1, marginBottom: 1 }} />
    </box>
  );
}

function TaskDisclosureButton(props: {
  taskId: string;
  theme: Theme;
  bg: string;
  selected: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
}): ReactNode {
  const { taskId, theme, bg, selected, expanded, onToggle } = props;
  const [hovered, setHovered] = useState(false);
  const highlighted = selected || hovered;
  const id = `plan-task-${taskId}-disclosure`;
  return (
    <box
      id={id}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event: MouseEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onToggle(taskId);
      }}
      style={{ width: TASK_DISCLOSURE_BUTTON_WIDTH, height: 1, flexShrink: 0, justifyContent: "center", alignItems: "center", backgroundColor: bg }}
    >
      <text selectable={false} id={`${id}-label`} wrapMode="none" content={expanded ? "−" : "+"} style={{ fg: highlighted ? theme.cyan : theme.foreground, bg, width: 1, height: 1, flexShrink: 0, attributes: TextAttributes.BOLD }} />
    </box>
  );
}

const TaskRow = memo(function TaskRow(props: {
  task: PlanTask;
  theme: Theme;
  width: number;
  active: boolean;
  selected: boolean;
  expanded: boolean;
  index: number;
  onToggle: (id: string) => void;
}): ReactNode {
  const { task, theme, width, active, selected, expanded, index, onToggle } = props;
  const stateColor = tokenFg(theme, taskRowColor(task));
  const titleColor = task.state === "pending" || task.state === "skipped" ? theme.foreground : stateColor;
  const bg = active || (task.state === "in_progress" && !task.responderOwned)
    ? theme.rowA
    : index % 2 === 0 ? theme.rowB : theme.statusBackground;
  const ownerChip = taskOwnerChip(task);
  const title = `${task.parentTaskId ? "↳ " : ""}${ownerChip ? `[${ownerChip}] ` : ""}${cleanTaskTitle(task)}`;
  const expandable = hasTaskDetails(task);
  const titleLines = wrapTaskDisclosureTitle(title, width, expandable);
  const titleAttributes = task.state === "in_progress" || active ? TextAttributes.BOLD : TextAttributes.NONE;

  return (
    <box id={`plan-task-${task.id}`} style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
      <box style={{ flexDirection: "row", width: "100%", flexShrink: 0, alignItems: "stretch", backgroundColor: bg }}>
        <box style={{ width: 1, flexShrink: 0, alignSelf: "stretch", backgroundColor: stateColor, minHeight: 1 }} />
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0, justifyContent: "center", paddingLeft: 1, paddingTop: 1, paddingBottom: 1, backgroundColor: bg }}>
          <box
            id={`plan-task-${task.id}-header`}
            style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}
          >
            {titleLines.map((line, lineIndex) => {
              const last = lineIndex === titleLines.length - 1;
              return (
                <box key={`title-${lineIndex}`} style={{ flexDirection: "row", flexShrink: 0 }}>
                  <text selectable
                    id={`plan-task-${task.id}-title-${last ? "end" : lineIndex}`}
                    wrapMode="none"
                    content={`${lineIndex === 0 ? taskGlyph(task) : " "} ${line}`}
                    style={{ fg: titleColor, bg, height: 1, flexShrink: 0, attributes: titleAttributes }}
                  />
                  {last && expandable ? (
                    <>
                      <text selectable={false} content=" " style={{ bg, height: 1, flexShrink: 0 }} />
                      <TaskDisclosureButton taskId={task.id} theme={theme} bg={bg} selected={selected} expanded={expanded} onToggle={onToggle} />
                    </>
                  ) : null}
                </box>
              );
            })}
          </box>
          {expanded && expandable ? <TaskDetails task={task} theme={theme} width={Math.max(1, width - 6)} bg={bg} /> : null}
        </box>
      </box>
      <text selectable={false} content=" " style={{ bg: theme.statusBackground, height: 1, width: "100%" }} />
    </box>
  );
});

function TaskDetails(props: { task: PlanTask; theme: Theme; width: number; bg: string }): ReactNode {
  const { task, theme, width, bg } = props;
  const lines = useMemo(() => wrapPlanText(taskDetailText(task), width), [task, width]);
  return (
    <box id={`plan-task-${task.id}-details`} style={{ flexDirection: "column", flexShrink: 0, width: "100%" }}>
      {lines.map((line, index) => <text selectable key={`body-${index}`} content={line} style={{ fg: theme.muted, bg, height: 1, attributes: TextAttributes.DIM }} />)}
    </box>
  );
}
export const PlanView = memo(PlanViewImpl);
