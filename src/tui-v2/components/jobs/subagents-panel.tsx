
/** @jsxImportSource @opentui/react */

import { memo, useEffect, useState, type ReactNode } from "react";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import { useSessionState } from "../../../ui-core/react/use-session-state.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { orderSubagentRuns, subagentsBarVisible, watchSubagents } from "../../../ui-core/rendering/subagent-source.js";
import { openSubagentRun, SUBAGENT_STATUS_ICON } from "../../../ui-core/commands/subagent-commands.js";
import type { SubagentRun } from "../../../agent/subagents/types.js";

export interface SubagentsPanelProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  readonly blockingOverlay?: boolean | undefined;
}

const MAX_ROWS = 3;

function statusColor(run: SubagentRun, theme: Theme): string {
  const status = SUBAGENT_STATUS_ICON[run.status];
  if (status?.tone === "success") return theme.success;
  if (status?.tone === "error") return theme.failedBg;
  if (status?.tone === "warn") return theme.accent;
  return theme.muted;
}

export const SubagentsPanel = memo(function SubagentsPanel(props: SubagentsPanelProps): ReactNode {
  const { services, theme, width, blockingOverlay } = props;
  const session = useSessionState(services.session);
  const manager = services.session.subagents;
  const [collapsed, setCollapsed] = useState(true);
  const [runs, setRuns] = useState<readonly SubagentRun[]>(() => manager.list());

  useEffect(() => {
    const refresh = (): void => {
      if (services.session.subagents !== manager) return;
      setRuns(manager.list());
    };
    refresh();
    const stopManager = manager.subscribe(refresh);
    const stopWatch = watchSubagents(manager, refresh);
    const stopSession = services.session.subscribe(() => {
      if (services.session.subagents === manager) refresh();
      else setRuns([]);
    });
    return () => {
      stopManager();
      stopWatch();
      stopSession();
    };
  }, [services.session, manager]);

  if (blockingOverlay || !subagentsBarVisible(runs)) return null;
  const ordered = orderSubagentRuns(runs);
  const running = ordered.filter((run) => run.status === "running" || run.status === "stopping").length;
  const settled = ordered.length - running;
  const shown = ordered.slice(0, MAX_ROWS);
  const hidden = Math.max(0, ordered.length - shown.length);
  const stateColor = running > 0 ? theme.cyan : settled > 0 ? theme.success : theme.muted;
  const header = `${collapsed ? "▸" : "▾"} Subagents: ${running} running · ${settled} done`;

  function toggle(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setCollapsed((value) => !value);
  }

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width,
        flexShrink: 0,
        borderColor: stateColor,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box onMouseDown={toggle} style={{ width: "100%", height: 1, flexShrink: 0 }}>
        <text
          content={header}
          wrapMode="none"
          style={{ width: "100%", height: 1, fg: stateColor, attributes: TextAttributes.BOLD }}
        />
      </box>
      {!collapsed
        ? shown.map((run) => {
            const icon = SUBAGENT_STATUS_ICON[run.status]?.icon ?? "•";
            const route = `${run.activeProvider ?? run.provider}/${run.activeModel ?? run.model}`;
            return (
              <box
                key={`${run.id}:${run.attempt}`}
                onMouseDown={(event: MouseEvent) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openSubagentRun(services, manager, run.id);
                }}
                style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}
              >
                <text content={`  ${icon} ${run.title}`} wrapMode="none" style={{ width: "100%", height: 1, fg: statusColor(run, theme) }} />
                <text content={`    ${run.status} · ${route}`} wrapMode="none" style={{ width: "100%", height: 1, fg: theme.muted }} />
              </box>
            );
          })
        : null}
      {!collapsed && hidden > 0 ? (
        <text content={`  +${hidden} more · /agents`} wrapMode="none" style={{ width: "100%", height: 1, fg: theme.muted }} />
      ) : null}
    </box>
  );
});
