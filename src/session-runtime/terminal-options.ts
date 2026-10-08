import type { RuntimeTerminalOptions, RuntimeViewFrame } from "./types.js";

const TERMINAL_ENV_KEYS = new Set([
  "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORFGBG",
  "NO_COLOR", "FORCE_COLOR", "CLAI_CLASSIC_MOUSE", "CLAI_KITTY_KEYBOARD", "TMUX",
]);

export function runtimeTerminalOptions(
  ui: RuntimeTerminalOptions["ui"] = "auto",
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTerminalOptions {
  return {
    ui,
    env: Object.fromEntries([...TERMINAL_ENV_KEYS].flatMap((key) => {
      const value = env[key];
      return typeof value === "string" && value.length <= 256 ? [[key, value]] : [];
    })),
  };
}

export function parseRuntimeTerminalOptions(value: unknown): RuntimeTerminalOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const terminal = value as Partial<RuntimeTerminalOptions>;
  if (!["auto", "classic", "tui"].includes(String(terminal.ui)) || !terminal.env || typeof terminal.env !== "object" || Array.isArray(terminal.env)) return undefined;
  const entries = Object.entries(terminal.env);
  if (entries.length > TERMINAL_ENV_KEYS.size || entries.some(([key, entry]) => !TERMINAL_ENV_KEYS.has(key) || typeof entry !== "string" || entry.length > 256)) return undefined;
  return { ui: terminal.ui!, env: Object.fromEntries(entries) };
}

export function runtimeViewFrame(value: unknown): RuntimeViewFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Partial<RuntimeViewFrame>;
  if (typeof frame.clientId !== "string" || !frame.clientId || frame.clientId.length > 128) return undefined;
  if (frame.type === "view-detach") return frame as RuntimeViewFrame;
  if (frame.type === "view-input") {
    if (typeof frame.data !== "string" || frame.data.length > 44 * 1024 || !frame.data || frame.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) return undefined;
    return frame as RuntimeViewFrame;
  }
  if (frame.type !== "view-attach" && frame.type !== "view-resize") return undefined;
  if (!Number.isInteger(frame.columns) || !Number.isInteger(frame.rows) || frame.columns! < 20 || frame.columns! > 1_000 || frame.rows! < 5 || frame.rows! > 500) return undefined;
  if (frame.type === "view-resize") return frame as RuntimeViewFrame;
  if (frame.type !== "view-attach") return undefined;
  const terminal = parseRuntimeTerminalOptions(frame.terminal);
  return terminal ? { ...frame, terminal } as RuntimeViewFrame : undefined;
}
