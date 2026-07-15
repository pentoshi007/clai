/** @jsxImportSource @opentui/react */
/**
 * Queued prompts while a turn is running (or waiting to drain).
 *
 * Each row is clickable:
 *  - Send now → interrupt current turn and run this prompt next
 *  - Edit → pull the draft back into the composer
 *  - × → drop from the queue
 *
 * If left alone, items run in order after the current turn finishes
 * (SessionController.continueQueue).
 */

import type { ReactNode } from "react";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { useSessionState } from "../../state/use-session-state.js";

export interface QueuePanelProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  /** Load a draft into the composer for editing. */
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
  // Header + rows + optional "N more" + borders.
  const height =
    2 + // borders
    1 + // header
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
            ? `  ${queued.length} waiting · send after current turn · click Send now to interrupt`
            : `  ${queued.length} waiting · will send next`,
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
  // " N. " + buttons budget, rest for preview.
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
