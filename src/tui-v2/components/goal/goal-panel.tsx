/** @jsxImportSource @opentui/react */

import { memo, useEffect, useState, type ReactNode } from "react";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import { useSessionState } from "../../../ui-core/react/use-session-state.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  GOAL_GLYPH,
  formatGoalStatus,
  goalStripModel,
  type GoalStripTone,
} from "../../../ui-core/rendering/goal-format.js";
import { clipSegment } from "../../../ui-core/rendering/status-segments.js";

export interface GoalPanelProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  readonly blockingOverlay?: boolean | undefined;
}

function toneColor(tone: GoalStripTone, theme: Theme): string {
  if (tone === "paused") return theme.activity;
  if (tone === "busy") return theme.spinner;
  return theme.magenta;
}

export const GoalPanel = memo(function GoalPanel(props: GoalPanelProps): ReactNode {
  const { services, theme, width, blockingOverlay } = props;
  const session = useSessionState(services.session);
  const goal = session.goal;
  const ticking = goal?.status === "active" && !blockingOverlay;
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [ticking]);

  if (!goal || blockingOverlay) return null;
  const model = goalStripModel(goal, Math.max(now, goal.startedAt), session.running);
  const color = toneColor(model.tone, theme);
  const head = `${GOAL_GLYPH} ${model.label}`;
  const details = model.details.length > 0 ? ` · ${model.details.join(" · ")}` : "";
  const room = Math.max(0, width - 2 - head.length - details.length - 3);
  const objective = room > 1 ? ` · ${clipSegment(model.objective.replace(/\s+/g, " "), room)}` : "";

  function openStatus(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const report = services.session.goalReport();
    if (report) services.overlay.openPager("Goal", formatGoalStatus(report), undefined, undefined, "force");
  }

  return (
    <box
      onMouseDown={openStatus}
      style={{
        flexDirection: "row",
        width,
        height: 1,
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.statusBackground,
      }}
    >
      <text
        content={head}
        wrapMode="none"
        style={{ height: 1, flexShrink: 0, fg: color, attributes: TextAttributes.BOLD }}
      />
      <text content={details} wrapMode="none" style={{ height: 1, flexShrink: 0, fg: theme.muted }} />
      <text content={objective} wrapMode="none" style={{ height: 1, flexGrow: 1, flexShrink: 1, fg: theme.foreground }} />
    </box>
  );
});
