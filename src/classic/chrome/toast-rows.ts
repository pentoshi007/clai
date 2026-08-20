import type { ToastItem, ToastLevel } from "../../ui-core/controllers/toast-controller.js";
import { clipToWidth, padToWidth } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import { MAX_TOAST_ROWS } from "./row-budget.js";
import { wrapAnsiLine } from "../render/wrap.js";

/** Solid plate per level — opentui toast-host parity (amber for info/warn). */
const PLATE: Readonly<Record<ToastLevel, ThemeToken>> = {
  success: "successBg",
  warn: "mode",
  error: "failedBg",
  info: "mode",
};

const H_PAD = 2;

function pillInnerWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  const maxPill = Math.max(20, Math.min(width - 4, Math.floor(width * 0.85)));
  return Math.max(8, maxPill - H_PAD * 2);
}

export function toastRowsWanted(
  toasts: readonly ToastItem[],
  columns: number,
): number {
  if (toasts.length === 0) return 0;
  const inner = pillInnerWidth(columns);
  let rows = 0;
  for (const toast of toasts) {
    const body = `·  ${toast.message.replace(/\s+/g, " ").trim()}`;
    rows += Math.max(1, Math.min(wrapAnsiLine(body, inner).length, MAX_TOAST_ROWS));
    if (rows >= MAX_TOAST_ROWS) return MAX_TOAST_ROWS;
  }
  return Math.min(rows, MAX_TOAST_ROWS);
}

export interface ToastViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly allocatedRows: number;
  readonly toasts: readonly ToastItem[];
}

export function visibleToasts(
  toasts: readonly ToastItem[],
  allocatedRows: number,
): readonly ToastItem[] {
  const rows = Math.max(0, Math.min(Math.floor(allocatedRows), MAX_TOAST_ROWS));
  return toasts.slice(Math.max(0, toasts.length - rows));
}

function levelGlyph(ink: InkTheme, level: ToastLevel): string {
  switch (level) {
    case "success":
      return ink.glyphs.toolOk;
    case "warn":
      return "!";
    case "error":
      return ink.glyphs.toolFailed;
    default:
      return "·";
  }
}

/**
 * One centered pill per toast — wraps big messages instead of truncating with …
 * Each toast may occupy 1-2 rows; total rows are capped by allocatedRows (and MAX_TOAST_ROWS).
 */
export function toastRows(input: ToastViewInput): readonly string[] {
  const { ink } = input;
  const width = Math.max(1, Math.floor(input.columns));
  const maxPill = Math.max(20, Math.min(width - 4, Math.floor(width * 0.85)));
  const inner = Math.max(8, maxPill - H_PAD * 2);
  const budget = Math.max(0, Math.min(Math.floor(input.allocatedRows), MAX_TOAST_ROWS));
  if (budget === 0 || input.toasts.length === 0) return [];

  // Newest first, but respect budget in *rows* not just toast count (big toasts wrap).
  const reversed = [...input.toasts].reverse();
  const hiddenCountForLast = (visibleCount: number): number => {
    const hidden = input.toasts.length - visibleCount;
    return hidden;
  };

  const rows: string[] = [];
  let usedToasts = 0;

  for (const toast of reversed) {
    if (rows.length >= budget) break;
    usedToasts += 1;
    const hidden = hiddenCountForLast(usedToasts);
    const overflow = hidden > 0 && usedToasts === Math.min(budget, reversed.length) ? ` (+${hidden})` : "";
    // Show overflow only on the oldest visible toast's last line
    const rawBody = `${levelGlyph(ink, toast.level)}  ${toast.message.replace(/\s+/g, " ").trim()}${usedToasts === Math.min(input.toasts.length, budget) && hidden > 0 ? ` (+${hidden})` : ""}`;
    // Wrap instead of clip — up to 2 lines per toast to avoid eating whole screen
    const wrapped = wrapAnsiLine(rawBody, inner);
    const lines = wrapped.length === 0 ? [""] : wrapped;
    const clippedLines = lines.length > 2 ? [...lines.slice(0, 1), clipToWidth(lines.slice(1).join(" "), inner, ink.glyphs.ellipsis)] : lines;
    const displayLines = clippedLines.slice(0, Math.max(1, budget - rows.length));
    // If this toast would exceed budget, truncate its last line with ellipsis
    const effectiveLines =
      rows.length + displayLines.length > budget
        ? displayLines.slice(0, budget - rows.length)
        : displayLines;

    for (let li = 0; li < effectiveLines.length; li += 1) {
      const line = effectiveLines[li]!;
      const isLastLineOfToast = li === effectiveLines.length - 1;
      const needsOverflow = isLastLineOfToast && usedToasts === Math.min(reversed.length, budget) && hidden > 0 && effectiveLines.length === displayLines.length;
      const text = needsOverflow && !line.includes(` (+${hidden})`) ? clipToWidth(`${line} (+${hidden})`, inner, ink.glyphs.ellipsis) : line;
      const pillWidth = Math.min(maxPill, Math.max(16, layoutWidth(text) + H_PAD * 2));
      const pill = ink.plate(PLATE[toast.level], padToWidth(`${" ".repeat(H_PAD)}${text}`, pillWidth));
      const leftPad = Math.max(0, Math.floor((width - pillWidth) / 2));
      const rightPad = Math.max(0, width - pillWidth - leftPad);
      rows.push(`${" ".repeat(leftPad)}${pill}${" ".repeat(rightPad)}`);
      if (rows.length >= budget) break;
    }
  }

  return rows;
}
