import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";


export interface ConsoleGuardOptions {
  readonly logDir: string;
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
