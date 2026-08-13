import { clipToWidth } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";
import { QUEUE_MAX_ROWS } from "./row-budget.js";

export interface QueueViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly allocatedRows: number;
  readonly queued: readonly string[];
  readonly selected: number;
}

const HINTS = ["^Y/^V select", "^S send", "^] edit", "^_ drop"];
const ASCII_HINTS = ["ctrl+y/v select", "ctrl+s send", "ctrl+] edit", "ctrl+_ drop"];

export function queueRowsWanted(count: number): number {
  return count === 0 ? 0 : Math.min(count + 1, QUEUE_MAX_ROWS);
}

export function queueRows(input: QueueViewInput): readonly string[] {
  const { ink } = input;
  const granted = Math.min(Math.max(0, Math.floor(input.allocatedRows)), QUEUE_MAX_ROWS);
  if (input.queued.length === 0 || granted < 2) return [];

  const width = Math.max(1, Math.floor(input.columns));
  const hints = ink.unicode ? HINTS : ASCII_HINTS;
  const header = clipToWidth(
    ink.fg(
      "activity",
      `${ink.glyphs.warning} ${input.queued.length} queued ${ink.glyphs.separator} ${hints.join(` ${ink.glyphs.separator} `)}`,
    ),
    width,
    ink.glyphs.ellipsis,
  );

  const capacity = granted - 1;
  const overflowing = input.queued.length > capacity;
  const shown = input.queued.slice(0, overflowing ? capacity - 1 : capacity);
  const hidden = input.queued.length - shown.length;
  const selected = Math.max(0, Math.min(input.selected, input.queued.length - 1));

  const items = shown.map((entry, index) => {
    const mark =
      index === selected
        ? ink.fg("inputBorder", `${ink.glyphs.promptMark} `)
        : "  ";
    return clipToWidth(
      `  ${ink.fg("muted", String(index + 1))} ${mark}${entry.replace(/\s+/g, " ").trim()}`,
      width,
      ink.glyphs.ellipsis,
    );
  });

  if (hidden > 0) {
    items.push(
      clipToWidth(
        ink.fg("muted", `  ${ink.glyphs.ellipsis} +${hidden} more`),
        width,
        ink.glyphs.ellipsis,
      ),
    );
  }

  return [header, ...items];
}
