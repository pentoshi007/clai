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
  if (process.platform === "win32") {
    return { ok: false, reason: "Windows (OpenTUI not yet supported)" };
  }
  return evaluateTui({
    stdoutIsTTY: process.stdout.isTTY,
    stdinIsTTY: process.stdin.isTTY,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  });
}
