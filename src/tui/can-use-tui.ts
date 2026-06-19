export interface TuiCapability {
  ok: boolean;
  reason?: string;
}

export interface TuiEnv {
  stdoutIsTTY: boolean | undefined;
  stdinIsTTY: boolean | undefined;
  columns: number | undefined;
  rows: number | undefined;
}

export const MIN_COLS = 60;
export const MIN_ROWS = 14;

/**
 * Decide whether the full-screen TUI can run in the current terminal.
 * Pure and env-injected so it can be unit-tested without a real TTY.
 * Requires both stdio ends to be TTYs and a minimum window size; otherwise
 * the caller falls back to the classic REPL.
 */
export function evaluateTui(env: TuiEnv): TuiCapability {
  if (!env.stdoutIsTTY || !env.stdinIsTTY) {
    return { ok: false, reason: "not a TTY" };
  }
  const cols = env.columns ?? 0;
  const rows = env.rows ?? 0;
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    return { ok: false, reason: `terminal too small (${cols}x${rows})` };
  }
  return { ok: true };
}

export function canUseTui(): TuiCapability {
  return evaluateTui({
    stdoutIsTTY: process.stdout.isTTY,
    stdinIsTTY: process.stdin.isTTY,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  });
}
