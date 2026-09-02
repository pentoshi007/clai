/** @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { useSessionState } from "../../../ui-core/react/use-session-state.js";

export interface QueuePanelProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  readonly onEdit: (text: string) => void;
}

const MAX_VISIBLE = 4;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (max <= 1) return "…";
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

export function QueuePanel(props: QueuePanelProps): ReactNode {
  const { services, theme, width, onEdit } = props;
  const session = useSessionState(services.session);
  const queued = session.queued;
  if (queued.length === 0) return null;

  const contentWidth = Math.max(24, width - 2);
  const visible = queued.slice(0, MAX_VISIBLE);
  const hidden = queued.length - visible.length;
  const height =
    2 +
    1 +
    visible.length +
    (hidden > 0 ? 1 : 0);

  return (
    <box
      border
      borderStyle="rounded"
      title=" queued "
      titleAlignment="left"
      style={{
        width: "100%",
        height,
        flexShrink: 0,
        borderColor: theme.queued,
        backgroundColor: theme.statusBackground,
        flexDirection: "column",
      }}
    >
      <text
        content={pad(
          session.running
            ? `  ${queued.length} waiting · sends after completion · click Send now to interrupt`
            : `  ${queued.length} waiting · Send now or Edit`,
          contentWidth,
        )}
        style={{ fg: theme.muted, bg: theme.statusBackground }}
      />
      {visible.map((text, index) => (
        <QueueRow
          key={`${index}:${text.slice(0, 24)}`}
          index={index}
          text={text}
          width={contentWidth}
          theme={theme}
          onSendNow={() => services.session.sendQueuedNow(index)}
          onEdit={() => {
            const draft = services.session.takeQueued(index);
            if (draft !== undefined) onEdit(draft);
          }}
          onRemove={() => services.session.removeQueued(index)}
        />
      ))}
      {hidden > 0 ? (
        <text
          content={pad(`  ··· ${hidden} more in queue`, contentWidth)}
          style={{ fg: theme.muted, bg: theme.statusBackground }}
        />
      ) : null}
    </box>
  );
}

function QueueRow(props: {
  readonly index: number;
  readonly text: string;
  readonly width: number;
  readonly theme: Theme;
  readonly onSendNow: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  const { index, text, width, theme, onSendNow, onEdit, onRemove } = props;
  const prefix = ` ${index + 1}. `;
  const actions = "  [Send now] [Edit] [×]";
  const previewBudget = Math.max(8, width - prefix.length - actions.length);
  const preview = clip(text, previewBudget);
  const bg = index % 2 === 0 ? theme.rowA : theme.rowB;

  return (
    <box style={{ flexDirection: "row", width: "100%", backgroundColor: bg }}>
      <text
        content={`${prefix}${preview}`}
        style={{ fg: theme.foreground, bg, flexGrow: 1 }}
      />
      <box style={{ flexDirection: "row", flexShrink: 0, backgroundColor: bg }}>
        <box onMouseDown={onSendNow}>
          <text content="[Send now]" style={{ fg: theme.accent, bg }} />
        </box>
        <text content=" " style={{ bg }} />
        <box onMouseDown={onEdit}>
          <text content="[Edit]" style={{ fg: theme.mode, bg }} />
        </box>
        <text content=" " style={{ bg }} />
        <box onMouseDown={onRemove}>
          <text content="[×]" style={{ fg: theme.muted, bg }} />
        </box>
        <text content=" " style={{ bg }} />
      </box>
    </box>
  );
}

function pad(text: string, width: number): string {
  if (width <= 0) return text;
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}
