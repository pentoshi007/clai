/** @jsxImportSource @opentui/react */

import { memo, useEffect, useRef, type ReactNode } from "react";
import { countRender } from "../../perf/render-counters.js";
import { TextAttributes, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import type { PlanTask, SessionPlan, TaskState } from "../../../store/plan.js";
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
  orderPlanTasksForDisplay,
  wrapPlanText,
  type PlanColorToken,
} from "../../../ui-core/rendering/plan-view.js";
import { discardPlan, implementPlan } from "../../../ui-core/plan/plan-lifecycle.js";

export interface PlanViewProps {
  readonly theme: Theme;
  readonly plan: SessionPlan | undefined;
  readonly services: AppServices;
  readonly width?: number | undefined;
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
    <text
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
  label: string;
  fg: string;
  bg: string;
  onClick: () => void;
}): ReactNode {
  const { label, fg, bg, onClick } = props;
  return (
    <box
      onMouseDown={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      style={{ flexShrink: 0 }}
    >
      <text
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
  const { theme, plan, services, width: widthProp } = props;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const activeId = plan ? activeTaskId(plan) : undefined;
  const innerW = Math.max(14, (widthProp ?? 36) - 4);
  const displayTasks = plan ? orderPlanTasksForDisplay(plan.tasks) : [];

  useEffect(() => {
    if (activeId) {
      scrollRef.current?.scrollChildIntoView(`plan-task-${activeId}`);
    }
  }, [activeId, plan?.tasks.length, plan?.updatedAt]);

  function trapWheel(event: MouseEvent): void {
    if (!event.scroll) return;
    event.stopPropagation();
    services.focus.focusRegion("plan");
  }

  if (!plan) {
    return (
      <box
        style={{
          flexDirection: "column",
          flexGrow: 1,
          width: "100%",
          height: "100%",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.statusBackground,
        }}
        onMouseScroll={trapWheel}
        onMouseDown={() => services.focus.focusRegion("plan")}
      >
        <box
          style={{
            flexDirection: "column",
            alignItems: "center",
            flexShrink: 0,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <text
            content="◇"
            style={{ fg: theme.magenta, height: 1, attributes: TextAttributes.BOLD }}
          />
          <text content=" " style={{ height: 1 }} />
          <text
            content="No tasks yet"
            style={{
              fg: theme.foreground,
              height: 1,
              attributes: TextAttributes.BOLD,
            }}
          />
          <text content=" " style={{ height: 1 }} />
          <text
            content="Plan a multi-step job,"
            style={{ fg: theme.muted, height: 1 }}
          />
          <text
            content="then /implement."
            style={{ fg: theme.muted, height: 1 }}
          />
          <text content=" " style={{ height: 1 }} />
          <text
            content="Ctrl+H toggle  ·  Ctrl+P detail"
            style={{ fg: theme.cyan, height: 1 }}
          />
        </box>
      </box>
    );
  }

  const progress = progressView(plan);
  const statusFg = tokenFg(theme, planStatusColor(plan.status));
  const statusBg =
    plan.status === "completed"
      ? theme.diffAddBg
      : plan.status === "in_progress" || plan.status === "approved"
        ? theme.queued
        : plan.status === "draft"
          ? theme.chipTeal
          : theme.chip;
  const goalLines = wrapPlanText(plan.goal, innerW);
  const barWidth = Math.max(6, Math.min(14, innerW - 12));
  const bar = progressBar(progress.done, progress.total, barWidth);
  const countLabel =
    progress.total === 0
      ? "0 tasks"
      : `${progress.done}/${progress.total}`;

  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        width: "100%",
        height: "100%",
        backgroundColor: theme.statusBackground,
      }}
      onMouseScroll={trapWheel}
      onMouseDown={() => services.focus.focusRegion("plan")}
    >
      {}
      <box
        style={{
          flexDirection: "column",
          width: "100%",
          flexShrink: 0,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          backgroundColor: theme.statusBackground,
        }}
      >
        {goalLines.map((line, i) => (
          <text
            key={`g-${i}`}
            content={line}
            style={{
              fg: theme.foreground,
              height: 1,
              attributes: TextAttributes.BOLD,
            }}
          />
        ))}

        <text content=" " style={{ height: 1 }} />

        {}
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            height: 1,
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <Chip
            label={planStatusChip(plan.status)}
            fg={theme.white}
            bg={statusBg}
            theme={theme}
          />
          <text content="  " style={{ height: 1 }} />
          <text
            content={plan.kind || "general"}
            style={{ fg: theme.muted, height: 1 }}
          />
        </box>

        {}
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            height: 1,
            marginTop: 1,
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <text
            content={bar}
            style={{
              fg:
                progress.done === progress.total && progress.total > 0
                  ? theme.success
                  : theme.cyan,
              height: 1,
              flexShrink: 0,
            }}
          />
          <text content="  " style={{ height: 1 }} />
          <text
            content={countLabel}
            style={{
              fg: statusFg,
              height: 1,
              attributes: TextAttributes.BOLD,
            }}
          />
        </box>

        {plan.status === "draft" ? (
          <box
            style={{
              flexDirection: "row",
              width: "100%",
              height: 1,
              marginTop: 1,
              flexShrink: 0,
              alignItems: "center",
            }}
          >
            <ActionChip
              label="Implement"
              fg={theme.white}
              bg={theme.success}
              onClick={() => void implementPlan(services)}
            />
            <text content="  " style={{ height: 1 }} />
            <ActionChip
              label="Discard"
              fg={theme.foreground}
              bg={theme.chip}
              onClick={() => void discardPlan(services)}
            />
          </box>
        ) : null}

        {}
        <text
          content={"─".repeat(Math.max(8, innerW))}
          style={{ fg: theme.border, height: 1, marginTop: 1 }}
        />
      </box>

      {}
      <scrollbox
        ref={scrollRef}
        stickyScroll={false}
        viewportCulling
        scrollY
        scrollX={false}
        scrollbarOptions={{ visible: false, showArrows: false }}
        onMouseScroll={trapWheel}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          width: "100%",
          minHeight: 4,
          backgroundColor: theme.statusBackground,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 0,
        }}
      >
        {displayTasks.map((task, index) => (
          <TaskRow
            key={task.id}
            task={task}
            theme={theme}
            width={innerW}
            active={task.id === activeId}
            index={index}
          />
        ))}
        <text content=" " style={{ height: 1 }} />
      </scrollbox>
    </box>
  );
}

function TaskRow(props: {
  task: PlanTask;
  theme: Theme;
  width: number;
  active: boolean;
  index: number;
}): ReactNode {
  const { task, theme, width, active, index } = props;
  const state = task.state as TaskState;
  const stateColor = tokenFg(theme, taskRowColor(task));
  const titleColor =
    state === "pending" || state === "skipped"
      ? theme.foreground
      : stateColor;
  const glyph = taskGlyph(task);
  const bg =
    active || (state === "in_progress" && !task.responderOwned)
      ? theme.rowA
      : index % 2 === 0
        ? theme.rowB
        : theme.statusBackground;
  const ownerChip = taskOwnerChip(task);
  const title =
    `${task.parentTaskId ? "↳ " : ""}` +
    `${ownerChip ? `[${ownerChip}] ` : ""}${cleanTaskTitle(task)}`;
  const titleBudget = Math.max(8, width - 5);
  const titleLines = wrapPlanText(title, titleBudget);
  const jobLabel = task.jobId
    ? `job=${task.jobId}${task.processId ? ` pid=${task.processId}` : ""}`
    : undefined;
  const noteText = [jobLabel, task.note?.trim()].filter(Boolean).join(" · ");
  const noteLines = noteText
    ? wrapPlanText(noteText, Math.max(8, width - 6))
    : [];

  const firstTitle = titleLines[0] ?? "";
  const titleAttributes =
    state === "in_progress" || active
      ? TextAttributes.BOLD
      : TextAttributes.NONE;

  return (
    <box
      id={`plan-task-${task.id}`}
      style={{
        flexDirection: "column",
        width: "100%",
        flexShrink: 0,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          flexShrink: 0,
          alignItems: "stretch",
          backgroundColor: bg,
        }}
      >
        {}
        <box
          style={{
            width: 1,
            flexShrink: 0,
            alignSelf: "stretch",
            backgroundColor: stateColor,
            minHeight: 1,
          }}
        />
        <box
          style={{
            flexDirection: "column",
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            justifyContent: "center",
            paddingLeft: 1,
            paddingRight: 1,
            paddingTop: 1,
            paddingBottom: 1,
            backgroundColor: bg,
          }}
        >
          <text
            content={`${glyph} ${firstTitle}`}
            style={{
              fg: titleColor,
              bg,
              height: 1,
              attributes: titleAttributes,
            }}
          />
          {titleLines.slice(1).map((line, i) => (
            <text
              key={`t-${task.id}-${i}`}
              content={`  ${line}`}
              style={{
                fg: titleColor,
                bg,
                height: 1,
                attributes: titleAttributes,
              }}
            />
          ))}
          {noteLines.map((line, i) => (
            <text
              key={`n-${task.id}-${i}`}
              content={line}
              style={{
                fg: theme.muted,
                bg,
                height: 1,
                attributes: TextAttributes.DIM,
              }}
            />
          ))}
        </box>
      </box>
      {}
      <text
        content=" "
        style={{ bg: theme.statusBackground, height: 1, width: "100%" }}
      />
    </box>
  );
}
export const PlanView = memo(PlanViewImpl);