export const ESC = "\x1b";
export const CSI = "\x1b[";
export const SS3 = "\x1bO";
export const BEL = "\x07";
export const ST = "\x1b\\";

export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const CURSOR_HOME = "\x1b[H";
export const CLEAR_SCREEN = "\x1b[2J";
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export const ESCAPE_TIMEOUT_MS = 25;
export const PASTE_TIMEOUT_MS = 250;
export const PASTE_MAX_BYTES = 1_048_576;

export const CTRL_C_QUIT_WINDOW_MS = 1500;
export const ESC_CANCEL_WINDOW_MS = 1500;
export const ESC_SAME_PRESS_MS = 80;

export const MOD_SHIFT = 1;
export const MOD_ALT = 2;
export const MOD_CTRL = 4;
export const MOD_META = 8;

export const CSI_FINAL_KEYS: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

export const SS3_KEYS: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  M: "enter",
};

export const CSI_TILDE_KEYS: Readonly<Record<number, string>> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

export const CSI_U_KEYS: Readonly<Record<number, string>> = {
  8: "backspace",
  9: "tab",
  13: "enter",
  27: "escape",
  32: "space",
  127: "backspace",
};

export const CTRL_LETTER_EXCEPTIONS: Readonly<Record<number, string>> = {
  0x08: "h",
  0x09: "tab",
  0x0a: "j",
  0x0d: "enter",
};

export const CTRL_SYMBOLS: Readonly<Record<number, string>> = {
  0x00: "space",
  0x1c: "\\",
  0x1d: "]",
  0x1e: "^",
  0x1f: "_",
};

export function modifiersFromCsi(value: number | undefined): {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
} {
  const mask = value === undefined || value < 1 ? 0 : value - 1;
  return {
    shift: (mask & MOD_SHIFT) !== 0,
    alt: (mask & MOD_ALT) !== 0,
    ctrl: (mask & MOD_CTRL) !== 0,
    meta: (mask & MOD_META) !== 0,
  };
}

export function isCsiFinalByte(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

export function isCsiParameterByte(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x20 && code <= 0x3f;
}
