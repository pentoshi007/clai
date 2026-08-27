/** @jsxImportSource @opentui/react */
/**
 * Slash / @-mention completion list rendered ABOVE the composer (legacy parity).
 * Rows are mouse-hoverable and clickable (pickers parity).
 */

import type { ReactNode } from "react";
import type { MouseEvent } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import type { CompletionMenu } from "../../../ui-core/composer/completion.js";
import {
  completionAbsoluteIndex,
  completionViewportWindow,
  completionWheelRows,
} from "../../../ui-core/composer/completion-viewport.js";
import type { CommandDefinition } from "../../../app/commands/command.js";
import type { FileSuggestion } from "../../../ui/mentions.js";

export interface CompletionMenuViewProps {
  readonly menu: CompletionMenu;
  readonly selected: number;
  readonly hoveredIndex?: number | undefined;
  readonly viewportOffset: number;
  readonly theme: Theme;
  readonly width: number;
  readonly maxRows?: number | undefined;
  readonly onHoverIndex?: ((index: number | undefined) => void) | undefined;
  readonly onActivateIndex?: ((index: number) => void) | undefined;
  readonly onScrollRows?: ((rows: number) => void) | undefined;
}

function padLine(text: string, width: number): string {
  if (width <= 0) return text;
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

export function CompletionMenuView(props: CompletionMenuViewProps): ReactNode {
  const {
    menu,
    selected,
    hoveredIndex,
    viewportOffset,
    theme,
    width,
    maxRows = 10,
    onHoverIndex,
    onActivateIndex,
    onScrollRows,
  } = props;
  if (menu.kind === "none") return null;

  const window = completionViewportWindow(
    menu.items.length,
    maxRows,
    viewportOffset,
  );
  const items = menu.items.slice(window.start, window.end);
  const before = window.before;
  const after = window.after;
  // Header (hints) + rule boundary + optional earlier/more rows + items.
  const menuHeight = 4 + items.length + (before > 0 ? 1 : 0) + (after > 0 ? 1 : 0);
  // Borders consume two terminal columns; padding to the outer width used to
  // make the last character overwrite the right rail on narrow terminals.
  const contentWidth = Math.max(10, width - 2);
  const onMouseScroll = (event: MouseEvent): void => {
    if (!event.scroll) return;
    event.preventDefault();
    event.stopPropagation();
    const rows = completionWheelRows(event.scroll.direction, event.scroll.delta);
    if (rows !== 0) onScrollRows?.(rows);
  };

  return (
    <box
      onMouseScroll={onMouseScroll}
      style={{
        flexDirection: "column",
        width: "100%",
        height: menuHeight,
        flexShrink: 0,
        border: true,
        borderStyle: "rounded",
        borderColor: theme.border,
        backgroundColor: theme.background,
      }}
    >
      <text
        content={padLine(
          menu.kind === "slash"
            ? `  commands · ${menu.items.length}  ·  ↑↓:select  ·  wheel:scroll  ·  tab:complete  ·  enter/click:run  ·  esc:dismiss`
            : `  files & dirs · ${menu.items.length}  ·  ↑↓:select  ·  wheel:scroll  ·  enter:attach  ·  click:open/attach  ·  esc:dismiss`,
          contentWidth,
        )}
        style={{ fg: theme.muted, bg: theme.rowA }}
      />
      {/* Quiet boundary before match rows (muted, not neon cyan). */}
      <text
        content={padLine("─".repeat(Math.max(8, contentWidth)), contentWidth)}
        style={{ fg: theme.chip, bg: theme.background }}
      />
      {before > 0 ? (
        <text
          content={padLine(`  ↑ ${before} earlier match${before === 1 ? "" : "es"}`, contentWidth)}
          style={{ fg: theme.muted, bg: theme.rowB }}
        />
      ) : null}
      {items.map((item, i) => {
        const itemIndex = completionAbsoluteIndex(
          menu.items.length,
          maxRows,
          viewportOffset,
          i,
        )!;
        const focused = itemIndex === selected;
        const hovered = itemIndex === hoveredIndex;
        const bg = focused
          ? theme.selection
          : hovered
            ? theme.chip
            : i % 2 === 0
              ? theme.rowA
              : theme.rowB;
        const line =
          menu.kind === "slash"
            ? formatSlash(item as CommandDefinition, focused, contentWidth)
            : formatFile(item as FileSuggestion, focused, contentWidth);
        const key =
          menu.kind === "slash"
            ? (item as CommandDefinition).name
            : (item as FileSuggestion).value || (item as FileSuggestion).label;
        const mouseProps = {
          ...(onHoverIndex
            ? {
                onMouseOver: () => {
                  onHoverIndex(itemIndex);
                },
                onMouseOut: () => {
                  onHoverIndex(undefined);
                },
              }
            : {}),
          ...(onActivateIndex
            ? {
                onMouseDown: (event: MouseEvent) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onActivateIndex(itemIndex);
                },
              }
            : {}),
        };
        return (
          <box
            key={key}
            style={{ width: "100%", backgroundColor: bg }}
            {...mouseProps}
          >
            <text
              content={line}
              style={{
                fg: focused || hovered ? theme.white : theme.foreground,
                bg,
              }}
            />
          </box>
        );
      })}
      {after > 0 ? (
        <text
          content={padLine(`  ↓ ${after} more match${after === 1 ? "" : "es"}`, contentWidth)}
          style={{ fg: theme.muted, bg: theme.rowB }}
        />
      ) : null}
    </box>
  );
}

function formatSlash(cmd: CommandDefinition, focused: boolean, width: number): string {
  const mark = focused ? " ❯ " : "   ";
  const name = `/${cmd.name}`.padEnd(14);
  const usage = cmd.usage ? `${cmd.usage} ` : "";
  const desc = cmd.description;
  return padLine(`${mark}${name}${usage} ${desc}`, width);
}

function formatFile(file: FileSuggestion, focused: boolean, width: number): string {
  const mark = focused ? " ❯ " : "   ";
  const icon = file.isDir ? "▸ " : "· ";
  const meta = file.isDir
    ? "  dir · click open · Enter attach folder"
    : "  file · click/Enter attach";
  return padLine(`${mark}${icon}${file.value}${meta}`, width);
}
