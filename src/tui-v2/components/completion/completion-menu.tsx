/** @jsxImportSource @opentui/react */
/**
 * Slash / @-mention completion list rendered ABOVE the composer (legacy parity).
 * Rows are mouse-hoverable and clickable (pickers parity).
 */

import type { ReactNode } from "react";
import type { Theme } from "../../rendering/theme.js";
import type { CompletionMenu } from "../../composer/completion.js";
import type { CommandDefinition } from "../../../app/commands/command.js";
import type { FileSuggestion } from "../../../ui/mentions.js";

export interface CompletionMenuViewProps {
  readonly menu: CompletionMenu;
  readonly selected: number;
  readonly theme: Theme;
  readonly width: number;
  readonly maxRows?: number | undefined;
  /** Highlight the row under the mouse (keyboard selection stays independent). */
  readonly onHoverIndex?: ((index: number) => void) | undefined;
  /**
   * Activate a row on click.
   * Slash / file → accept; directory → typically drill (caller decides).
   */
  readonly onActivateIndex?: ((index: number) => void) | undefined;
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
    theme,
    width,
    maxRows = 10,
    onHoverIndex,
    onActivateIndex,
  } = props;
  if (menu.kind === "none") return null;

  const visibleCount = Math.min(maxRows, menu.items.length);
  // Keep the active command on screen while allowing the menu to show a
  // useful window of the whole catalogue instead of permanently clipping it
  // to the first handful of options.
  const start = Math.min(
    Math.max(0, selected - Math.floor(visibleCount / 2)),
    Math.max(0, menu.items.length - visibleCount),
  );
  const items = menu.items.slice(start, start + visibleCount);
  const before = start;
  const after = menu.items.length - start - items.length;
  // Header (hints) + rule boundary + optional earlier/more rows + items.
  const menuHeight = 4 + items.length + (before > 0 ? 1 : 0) + (after > 0 ? 1 : 0);
  // Borders consume two terminal columns; padding to the outer width used to
  // make the last character overwrite the right rail on narrow terminals.
  const contentWidth = Math.max(10, width - 2);

  return (
    <box
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
            ? `  commands · ${menu.items.length}  ·  ↑↓:move  ·  tab/enter:accept  ·  click:accept  ·  esc:dismiss`
            : `  files & dirs · ${menu.items.length}  ·  ↑↓:move  ·  enter:attach  ·  click:open/attach  ·  esc:dismiss`,
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
        const itemIndex = start + i;
        const focused = itemIndex === selected;
        const bg = focused ? theme.selection : i % 2 === 0 ? theme.rowA : theme.rowB;
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
              }
            : {}),
          ...(onActivateIndex
            ? {
                onMouseDown: () => {
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
                fg: focused ? theme.white : theme.foreground,
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
