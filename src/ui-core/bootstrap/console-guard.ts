import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * While OpenTUI owns the screen it repaints only its own framebuffer region.
 * Anything printed straight to the tty lands in cells the renderer never
 * repaints, so the fragment sticks there for the rest of the session — that is
 * the stray column of leftover text along the right edge.
 *
 * Core modules still reach for `console.*` on rare paths (a permission error, a
 * provider capability warning, a plan dump), and any of them can fire mid-turn.
 * This guard routes those calls to a log file instead of the terminal.
 *
 * Only `console.*` is intercepted, never the std stream writers themselves: the
 * renderer emits frames straight through the stream, so patching that would
 * blank the UI.
 */

export interface ConsoleGuardOptions {
  readonly logDir: string;
  /** Receives every captured message, for optional in-app surfacing. */
  readonly onCapture?: ((level: string, message: string) => void) | undefined;
}

const GUARDED_METHODS = [
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "trace",
  "dir",
  "table",
] as const;

const MAX_CAPTURE_BYTES = 1024 * 1024;

function format(args: readonly unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.stack ?? value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

export function installConsoleGuard(options: ConsoleGuardOptions): () => void {
  let logPath: string | undefined;
  let written = 0;
  try {
    mkdirSync(options.logDir, { recursive: true });
    logPath = join(options.logDir, "tui-console.log");
  } catch {
    logPath = undefined;
  }

  const target = console as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();

  const capture = (level: string, message: string): void => {
    if (!message) return;
    options.onCapture?.(level, message);
    if (!logPath || written >= MAX_CAPTURE_BYTES) return;
    const line = `[${new Date().toISOString()}] ${level}: ${message}\n`;
    written += Buffer.byteLength(line);
    try {
      appendFileSync(logPath, line, { mode: 0o600 });
    } catch {
      logPath = undefined;
    }
  };

  for (const method of GUARDED_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    target[method] = (...args: unknown[]): void => {
      capture(method, format(args));
    };
  }

  return () => {
    for (const [method, original] of originals) {
      target[method] = original;
    }
    originals.clear();
  };
}
