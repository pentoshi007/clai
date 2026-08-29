import { ABANDONED_TERMINAL_RESET } from "./screen-sequences.js";

export interface RescueWritable {
  write(chunk: string): unknown;
}
export interface RescueRawMode {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  pause?(): unknown;
}

export interface RescueProcess {
  on(event: "exit", listener: (code?: number) => void): unknown;
  off(event: "exit", listener: (code?: number) => void): unknown;
}

export interface TerminalRescueOptions {
  readonly stdout?: RescueWritable | undefined;
  readonly stdin?: RescueRawMode | undefined;
  readonly proc?: RescueProcess | undefined;
}

export const TERMINAL_RESET_SEQUENCE = ABANDONED_TERMINAL_RESET;

let activeDisarm: (() => void) | undefined;

export function installTerminalRescue(
  options: TerminalRescueOptions = {},
): () => void {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? (process.stdin as RescueRawMode);
  const proc = options.proc ?? (process as unknown as RescueProcess);
  const usesInjectedProc = options.proc !== undefined;

  let armed = true;

  const restore = (): void => {
    try {
      stdin.setRawMode?.(false);
    } catch {}
    try {
      stdin.pause?.();
    } catch {}
    try {
      stdout.write(TERMINAL_RESET_SEQUENCE);
    } catch {}
  };

  const onExit = (): void => {
    if (!armed) return;
    armed = false;
    restore();
  };

  if (!usesInjectedProc) activeDisarm?.();
  proc.on("exit", onExit);

  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    proc.off("exit", onExit);
    if (!usesInjectedProc && activeDisarm === disarm) activeDisarm = undefined;
  };

  if (!usesInjectedProc) activeDisarm = disarm;
  return disarm;
}
