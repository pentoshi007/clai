import type { ColorMode } from "../../app/ports/terminal-port.js";

export type ThemeHint = "dark" | "light" | "unknown";

export interface CapabilityEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly platform?: string | undefined;
}

export interface TerminalCapabilityReport {
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly colorMode: ColorMode;
  readonly noColor: boolean;
  readonly kittyKeyboard: boolean;
  readonly canDistinguishShiftEnter: boolean;
  readonly mouse: boolean;
  readonly unicode: boolean;
  readonly osc52: boolean;
  readonly reducedMotion: boolean;
  readonly themeHint: ThemeHint;
}

export interface OpenTuiNativeAppearance {
  readonly themeMode?: "dark" | "light" | null | undefined;
  readonly rgb?: boolean | undefined;
  readonly ansi256?: boolean | undefined;
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

function explicitColorMode(
  env: CapabilityEnv["env"],
): { colorMode: ColorMode; noColor: boolean } | undefined {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return { colorMode: "none", noColor: true };
  }
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") {
    const level = env.FORCE_COLOR;
    if (level === "3" || level === "truecolor") {
      return { colorMode: "truecolor", noColor: false };
    }
    if (level === "2") return { colorMode: "256", noColor: false };
    return { colorMode: "16", noColor: false };
  }
  return undefined;
}

function detectColorMode(
  env: CapabilityEnv["env"],
  isTTY: boolean,
  platform?: string,
): { colorMode: ColorMode; noColor: boolean } {
  const explicit = explicitColorMode(env);
  if (explicit) return explicit;
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
  if (term === "" || term === "dumb") {
    if (platform === "win32") {
      if (env.WT_SESSION || env.ConEmuANSI === "ON" || env.TERMINAL_EMULATOR === "JetBrains-JediTerm") {
        return { colorMode: "truecolor", noColor: false };
      }
      return { colorMode: "16", noColor: false };
    }
    return { colorMode: "none", noColor: false };
  }
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
  if (locale === "") return true;
  return /utf-?8/i.test(locale);
}

function explicitThemeHint(
  env: CapabilityEnv["env"],
): Exclude<ThemeHint, "unknown"> | undefined {
  const explicit = (env.CLAI_THEME ?? "").toLowerCase();
  return explicit === "dark" || explicit === "light" ? explicit : undefined;
}

export function detectThemeHint(env: CapabilityEnv["env"]): ThemeHint {
  const explicit = explicitThemeHint(env);
  if (explicit) return explicit;
  const colorfgbg = env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = Number(parts[parts.length - 1]);
    if (Number.isFinite(bg)) return bg <= 6 ? "dark" : "light";
  }
  return "unknown";
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function detectCapabilities(
  input: CapabilityEnv,
): TerminalCapabilityReport {
  const { env } = input;
  const isTTY = input.stdoutIsTTY && input.stdinIsTTY;
  const { colorMode, noColor } = detectColorMode(env, isTTY, input.platform);
  const kittyKeyboard = isTTY && detectKittyKeyboard(env);

  return {
    isTTY,
    columns: positiveOr(input.columns, DEFAULT_COLUMNS),
    rows: positiveOr(input.rows, DEFAULT_ROWS),
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

const COLOR_DEPTH: Readonly<Record<ColorMode, number>> = {
  none: 0,
  "16": 1,
  "256": 2,
  truecolor: 3,
};

function nativeColorMode(
  native: OpenTuiNativeAppearance | undefined,
): ColorMode | undefined {
  if (native?.rgb) return "truecolor";
  if (native?.ansi256) return "256";
  if (native?.rgb === false || native?.ansi256 === false) return "16";
  return undefined;
}

export function resolveOpenTuiCapabilities(
  detected: TerminalCapabilityReport,
  env: CapabilityEnv["env"],
  native?: OpenTuiNativeAppearance,
): TerminalCapabilityReport {
  const explicitColor = explicitColorMode(env);
  const nativeMode = nativeColorMode(native);
  const deepest =
    nativeMode !== undefined &&
    COLOR_DEPTH[nativeMode] > COLOR_DEPTH[detected.colorMode]
      ? nativeMode
      : detected.colorMode;
  const color =
    explicitColor ??
    (!detected.isTTY
      ? { colorMode: "none" as const, noColor: false }
      : { colorMode: deepest, noColor: false });
  const themeHint =
    explicitThemeHint(env) ??
    native?.themeMode ??
    (detected.themeHint === "unknown" ? "dark" : detected.themeHint);

  return {
    ...detected,
    colorMode: color.colorMode,
    noColor: color.noColor,
    themeHint,
  };
}

export function readCapabilitiesFromProcess(): TerminalCapabilityReport {
  return detectCapabilities({
    env: process.env,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    platform: process.platform,
  });
}
