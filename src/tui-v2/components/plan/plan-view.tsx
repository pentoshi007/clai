/** @jsxImportSource @opentui/react */
/**
 * Plan side pane — compact goal + status + scrollable tasks.
 *
 * - No "PLAN" header (border title already says Plan)
 * - One progress line only (no bar + "completed · 8/8" duplication)
 * - Full text wrap, never "…" truncation
 * - Hidden scrollbar; wheel still scrolls the list
 */

import { useEffect, useRef, type ReactNode } from "react";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import type { PlanTask, SessionPlan, TaskState } from "../../../store/plan.js";
import type { Theme } from "../../rendering/theme.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import {
  activeTaskId,
  progressView,
  planStatusColor,
  STATUS_LABEL,
  TASK_GLYPH,
  taskStateColor,
  wrapPlanText,
  type PlanColorToken,
} from "../../rendering/plan-view.js";
import { discardPlan, implementPlan } from "../../app/plan-lifecycle.js";

export interface PlanViewProps {
  readonly theme: Theme;
  readonly plan: SessionPlan | undefined;
  readonly services: AppServices;
  readonly width?: number | undefined;
}

function tokenFg(theme: Theme, token: PlanColorToken): string {
  return theme[token];
}

export function PlanView(props: PlanViewProps): ReactNode {
  const { theme, plan, services, width: widthProp } = props;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const activeId = plan ? activeTaskId(plan) : undefined;
  const innerW = Math.max(14, (widthProp ?? 36) - 4);

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
        {/* Centered empty state — vertical + horizontal middle of the pane. */}
        <box
          style={{
            flexDirection: "column",
            alignItems: "center",
            flexShrink: 0,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <text content="No plan yet" style={{ fg: theme.muted, height: 1 }} />
          <text content=" " style={{ height: 1 }} />
          <text
            content="Plan a multi-step task,"
            style={{ fg: theme.muted, height: 1 }}
          />
          <text
            content="then /implement."
            style={{ fg: theme.muted, height: 1 }}
          />
          <text content=" " style={{ height: 1 }} />
          <text
            content="Ctrl+P · full detail"
            style={{ fg: theme.cyan, height: 1 }}
          />
        </box>
      </box>
    );
  }

  const progress = progressView(plan);
  const statusFg = tokenFg(theme, planStatusColor(plan.status));
  const goalLines = wrapPlanText(plan.goal, innerW);
  // One line only: "completed · 8/8 complete" → just status + count once
  const metaLine = `${STATUS_LABEL[plan.status]}  ·  ${progress.label}`;

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
            style={{ fg: theme.foreground, height: 1 }}
          />
        ))}
        <text content=" " style={{ height: 1 }} />
        <text content={metaLine} style={{ fg: statusFg, height: 1 }} />
        {plan.status === "draft" ? (
          <box
            style={{
              flexDirection: "row",
              width: "100%",
              height: 1,
              marginTop: 1,
              flexShrink: 0,
            }}
          >
            <box onMouseDown={() => void implementPlan(services)}>
              <text content="[Implement]" style={{ fg: theme.success, height: 1 }} />
            </box>
            <text content="  " style={{ height: 1 }} />
            <box onMouseDown={() => void discardPlan(services)}>
              <text content="[Discard]" style={{ fg: theme.muted, height: 1 }} />
            </box>
          </box>
        ) : null}
        {/* Boundary between goal/meta and the task list. */}
        <text
          content={"─".repeat(Math.max(8, innerW))}
          style={{ fg: theme.border, height: 1, marginTop: 1 }}
        />
      </box>

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
        }}
      >
        {plan.tasks.map((task, index) => (
          <TaskRow
            key={task.id}
            task={task}
            theme={theme}
            width={innerW}
            active={task.id === activeId}
            stripe={index % 2 === 1}
            showDivider={index < plan.tasks.length - 1}
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
  /** Alternate row face for clearer entry boundaries. */
  stripe: boolean;
  /** Draw a rule under this row (all but the last task). */
  showDivider: boolean;
}): ReactNode {
  const { task, theme, width, active, stripe, showDivider } = props;
  const state = task.state as TaskState;
  const color = tokenFg(theme, taskStateColor(state));
  const bg = active
    ? theme.rowA
    : stripe
      ? theme.rowB
      : theme.statusBackground;
  const glyph = TASK_GLYPH[state] ?? "○";
  // Wrap full title — never ellipsize.
  const titleLines = wrapPlanText(task.title, Math.max(8, width - 4));
  const first = `${glyph}  ${titleLines[0] ?? ""}`;
  const rule = "─".repeat(Math.max(8, width));

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
          flexDirection: "column",
          width: "100%",
          flexShrink: 0,
          backgroundColor: bg,
          paddingTop: 0,
          paddingBottom: 0,
        }}
      >
        <text content={first} style={{ fg: color, bg, height: 1 }} />
        {titleLines.slice(1).map((line, i) => (
          <text
            key={`t-${task.id}-${i}`}
            content={`   ${line}`}
            style={{ fg: color, bg, height: 1 }}
          />
        ))}
        {task.note ? (
          <text
            content={`   ${task.note.replace(/\s+/g, " ").trim()}`}
            style={{ fg: theme.muted, bg, height: 1 }}
          />
        ) : null}
      </box>
      {showDivider ? (
        <text
          content={rule}
          style={{
            fg: theme.border,
            bg: theme.statusBackground,
            height: 1,
          }}
        />
      ) : null}
    </box>
  );
}
