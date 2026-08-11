import type { MouseButton, MouseEvent } from "./key-event.js";

const BUTTON_MASK = 0b11;
const DRAG_FLAG = 32;
const WHEEL_FLAG = 64;
const SHIFT_FLAG = 4;
const ALT_FLAG = 8;
const CTRL_FLAG = 16;

const BUTTONS: readonly MouseButton[] = ["left", "middle", "right", "none"];

export function parseSgrMouse(
  params: string,
  final: string,
): MouseEvent | undefined {
  if (final !== "M" && final !== "m") return undefined;
  const parts = params.split(";");
  if (parts.length !== 3) return undefined;
  const code = Number(parts[0]);
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  if (!Number.isInteger(code) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return undefined;
  }
  if (code < 0 || x < 1 || y < 1) return undefined;

  const wheel = (code & WHEEL_FLAG) !== 0;
  const drag = !wheel && (code & DRAG_FLAG) !== 0;
  const buttonIndex = code & BUTTON_MASK;

  return {
    button: wheel ? "none" : (BUTTONS[buttonIndex] ?? "none"),
    x: x - 1,
    y: y - 1,
    release: final === "m",
    drag,
    scroll: wheel ? (buttonIndex === 0 ? "up" : "down") : undefined,
    ctrl: (code & CTRL_FLAG) !== 0,
    alt: (code & ALT_FLAG) !== 0,
    shift: (code & SHIFT_FLAG) !== 0,
  };
}
