import { writeSync } from "node:fs";

export interface TerminalWriteStream {
  write(text: string, callback?: (error?: Error | null) => void): unknown;
}

function writeSyncToFd(fd: number, text: string): boolean {
  try {
    writeSync(fd, text);
    return true;
  } catch {
    return false;
  }
}

function writeToStream(stream: TerminalWriteStream, text: string): boolean {
  try {
    stream.write(text);
    return true;
  } catch {
    return false;
  }
}

export function writeTerminalDirect(
  text: string,
  stream: TerminalWriteStream = process.stdout,
): void {
  const fd = (stream as { fd?: unknown }).fd;
  if (typeof fd === "number" && writeSyncToFd(fd, text)) return;
  writeToStream(stream, text);
}

export function writeTerminalAndWait(
  text: string,
  stream: TerminalWriteStream = process.stdout,
  timeoutMs = 1_000,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      stream.write(text, finish);
    } catch {
      finish();
    }
  });
}
