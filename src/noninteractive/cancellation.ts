export interface CancellationInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean | undefined;
  readonly isRaw?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
}

export interface CancellationProcess {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface NoninteractiveCancellationOptions {
  readonly input: CancellationInput;
  readonly proc?: CancellationProcess | undefined;
  readonly abort: () => void;
}

function hasCancelByte(chunk: string | Buffer): boolean {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return bytes.includes(0x03) || bytes.includes(0x1b);
}

export function installNoninteractiveCancellation(
  options: NoninteractiveCancellationOptions,
): () => void {
  const proc = options.proc ?? process;
  let active = true;
  let rawOwned = false;
  const abort = (): void => {
    if (!active) return;
    options.abort();
  };
  const onData = (chunk: string | Buffer): void => {
    if (hasCancelByte(chunk)) abort();
  };
  proc.on("SIGINT", abort);
  proc.on("SIGTERM", abort);
  if (options.input.isTTY && typeof options.input.setRawMode === "function") {
    try {
      rawOwned = !options.input.isRaw;
      if (rawOwned) options.input.setRawMode(true);
      options.input.on("data", onData);
      options.input.resume();
    } catch {
      rawOwned = false;
    }
  }
  return () => {
    if (!active) return;
    active = false;
    proc.off("SIGINT", abort);
    proc.off("SIGTERM", abort);
    options.input.off("data", onData);
    if (!rawOwned || typeof options.input.setRawMode !== "function") return;
    try {
      options.input.setRawMode(false);
    } catch {
      return;
    }
  };
}
