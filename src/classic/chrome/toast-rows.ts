import type { ToastItem, ToastLevel } from "../../ui-core/controllers/toast-controller.js";
import { clipToWidth, padToWidth } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import { MAX_TOAST_ROWS } from "./row-budget.js";

/** Solid plate per level — opentui toast-host parity (amber for info/warn). */
const PLATE: Readonly<Record<ToastLevel, ThemeToken>> = {
  success: "successBg",
  warn: "mode",
  error: "failedBg",
  info: "mode",
};

const H_PAD = 2;

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
 * One centered pill per toast at the top of the screen — opentui toast-host
 * parity: white bold message on a solid level plate, 2-column padding inside
 * the pill, natural width (capped at 85% of the column), newest first.
 */
export function toastRows(input: ToastViewInput): readonly string[] {
  const { ink } = input;
  const visible = visibleToasts(input.toasts, input.allocatedRows);
  if (visible.length === 0) return [];
  const hidden = input.toasts.length - visible.length;
  const width = Math.max(1, Math.floor(input.columns));
  const maxPill = Math.max(20, Math.min(width - 4, Math.floor(width * 0.85)));
  const inner = Math.max(8, maxPill - H_PAD * 2);

  return [...visible].reverse().map((toast, index) => {
    const overflow =
      hidden > 0 && index === visible.length - 1 ? ` (+${hidden})` : "";
    const body = `${levelGlyph(ink, toast.level)}  ${toast.message.replace(/\s+/g, " ").trim()}${overflow}`;
    const text = clipToWidth(body, inner, ink.glyphs.ellipsis);
    const pillWidth = Math.min(maxPill, Math.max(16, layoutWidth(text) + H_PAD * 2));
    const pill = ink.plate(
      PLATE[toast.level],
      padToWidth(`${" ".repeat(H_PAD)}${text}`, pillWidth),
    );
    const leftPad = Math.max(0, Math.floor((width - pillWidth) / 2));
    const rightPad = Math.max(0, width - pillWidth - leftPad);
    return `${" ".repeat(leftPad)}${pill}${" ".repeat(rightPad)}`;
  });
}
