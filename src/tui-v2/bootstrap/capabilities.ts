/**
 * Renderer-independent terminal capability detection (V2-030).
 *
 * Pure function of an injected environment snapshot so capability decisions are
 * unit-testable without a live TTY. The renderer adapter feeds this the real
 * `process.env`/stdio at bootstrap; nothing here writes terminal bytes.
 */

import type { ColorMode } from "../../app/ports/terminal-port.js";

export type ThemeHint = "dark" | "light" | "unknown";

export interface CapabilityEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
}

export interface TerminalCapabilityReport {
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly colorMode: ColorMode;
  readonly noColor: boolean;
  /** Kitty/CSI-u keyboard protocol; lets Shift+Enter differ from Enter. */
  readonly kittyKeyboard: boolean;
  readonly canDistinguishShiftEnter: boolean;
  readonly mouse: boolean;
  readonly unicode: boolean;
  readonly osc52: boolean;
  readonly reducedMotion: boolean;
  readonly themeHint: ThemeHint;
}

export const DEFAULT_COLUMNS = 80;
export const DEFAULT_ROWS = 24;

const TRUECOLOR_TERMS = ["iterm", "kitty", "wezterm", "ghostty", "vte", "alacritty"];
const KITTY_KEYBOARD_TERMS = ["kitty", "ghostty", "wezterm", "foot"];

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

function detectColorMode(
  env: CapabilityEnv["env"],
  isTTY: boolean,
): { colorMode: ColorMode; noColor: boolean } {
  // NO_COLOR is a hard opt-out regardless of terminal support.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return { colorMode: "none", noColor: true };
  }
  if (!isTTY) return { colorMode: "none", noColor: false };

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();

  if (colorterm === "truecolor" || colorterm === "24bit") {
    return { colorMode: "truecolor", noColor: false };
  }
  if (TRUECOLOR_TERMS.some((t) => termProgram.includes(t) || term.includes(t))) {
    return { colorMode: "truecolor", noColor: false };
  }
  if (term.includes("256")) return { colorMode: "256", noColor: false };
  if (term === "" || term === "dumb") return { colorMode: "none", noColor: false };
  return { colorMode: "16", noColor: false };
}

function detectKittyKeyboard(env: CapabilityEnv["env"]): boolean {
  const term = (env.TERM ?? "").toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  return KITTY_KEYBOARD_TERMS.some(
    (t) => term.includes(t) || termProgram.includes(t),
  );
}

function detectUnicode(env: CapabilityEnv["env"]): boolean {
  const locale = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`;
  if (locale === "") return true; // assume modern terminal when unset
  return /utf-?8/i.test(locale);
}

function detectThemeHint(env: CapabilityEnv["env"]): ThemeHint {
  const explicit = (env.CLAI_THEME ?? "").toLowerCase();
  if (explicit === "dark" || explicit === "light") return explicit;
  const colorfgbg = env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = Number(parts[parts.length - 1]);
    if (Number.isFinite(bg)) return bg <= 6 ? "dark" : "light";
  }
  return "unknown";
}

export function detectCapabilities(
  input: CapabilityEnv,
): TerminalCapabilityReport {
  const { env } = input;
  const isTTY = input.stdoutIsTTY && input.stdinIsTTY;
  const { colorMode, noColor } = detectColorMode(env, isTTY);
  const kittyKeyboard = isTTY && detectKittyKeyboard(env);

  return {
    isTTY,
    columns: input.columns ?? DEFAULT_COLUMNS,
    rows: input.rows ?? DEFAULT_ROWS,
    colorMode,
    noColor,
    kittyKeyboard,
    canDistinguishShiftEnter: kittyKeyboard,
    mouse: isTTY,
    unicode: detectUnicode(env),
    osc52: isTTY,
    reducedMotion: truthy(env.CLAI_REDUCED_MOTION) || truthy(env.NO_MOTION),
    themeHint: detectThemeHint(env),
  };
}

export function readCapabilitiesFromProcess(): TerminalCapabilityReport {
  return detectCapabilities({
    env: process.env,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  });
}
