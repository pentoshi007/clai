import { getArtifactDir } from "../../store/paths.js";
import { looksInteractiveStdin } from "../shell.js";
import { allowInteractiveStdinInherit } from "./internals.js";
import { safeArtifactName } from "./artifact-name.js";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_MODEL_BYTES = 12_000;

export const DEFAULT_MAX_CAPTURE_BYTES = 500 * 1024 * 1024;

export function chooseStdio(
  command: string,
  preference: boolean | "auto" | undefined,
): ["ignore" | "inherit", "pipe", "pipe"] {
  if (!allowInteractiveStdinInherit) return ["ignore", "pipe", "pipe"];
  if (preference === false) return ["ignore", "pipe", "pipe"];
  const wantInteractive =
    preference === true ||
    ((preference === "auto" || preference === undefined) &&
      looksInteractiveStdin(command));
  if (!wantInteractive) return ["ignore", "pipe", "pipe"];
  if (process.stdin.isTTY) return ["inherit", "pipe", "pipe"];
  return ["ignore", "pipe", "pipe"];
}

export function takeOverCookedStdin(): () => void {
  if (!process.stdin.isTTY) return () => {};
  const stream = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const wasRaw = Boolean(stream.isRaw);
  try {
    if (wasRaw) stream.setRawMode(false);
    process.stdin.pause();
  } catch {
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      if (process.stdin.isTTY) {
        if (wasRaw) stream.setRawMode(true);
      }
    } catch {
    }
    try {
      process.stdin.resume();
    } catch {
    }
  };
}

export async function openArtifact(
  command: string,
  override?: string,
): Promise<
  | {
      path: string;
      stream: WriteStream;
    }
  | undefined
> {
  try {
    const dir = override ? join(override, "..") : getArtifactDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path =
      override ??
      join(
        dir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeArtifactName(command)}.txt`,
      );
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    return { path, stream };
  } catch {
    return undefined;
  }
}

export class OutputDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private sniffed = 0;
  private nonPrintable = 0;
  private binaryDetected = false;

  decode(chunk: Buffer): { text: string; bytes: number } {
    this.sniff(chunk);
    return { text: this.decoder.write(chunk), bytes: chunk.byteLength };
  }

  end(): string {
    return this.decoder.end();
  }

  get isBinary(): boolean {
    return this.binaryDetected;
  }

  private sniff(chunk: Buffer): void {
    if (this.binaryDetected || this.sniffed >= 2_048) return;
    const sample = chunk.subarray(0, 2_048 - this.sniffed);
    for (const byte of sample) {
      if (byte === 0) {
        this.binaryDetected = true;
        return;
      }
      if (byte < 9 || (byte > 13 && byte < 32)) this.nonPrintable += 1;
    }
    this.sniffed += sample.byteLength;
    if (this.sniffed >= 256 && this.nonPrintable / this.sniffed > 0.3) {
      this.binaryDetected = true;
    }
  }
}

export class RingBuffer {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly capacity: number) {}

  push(text: string): void {
    if (text.length >= this.capacity) {
      this.chunks = [text.slice(text.length - this.capacity)];
      this.bytes = this.chunks[0]!.length;
      return;
    }
    this.chunks.push(text);
    this.bytes += text.length;
    while (this.bytes > this.capacity && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.bytes -= removed.length;
    }
    if (this.bytes > this.capacity && this.chunks.length === 1) {
      const only = this.chunks[0]!;
      this.chunks[0] = only.slice(only.length - this.capacity);
      this.bytes = this.chunks[0]!.length;
    }
  }

  toString(): string {
    return this.chunks.join("");
  }

  size(): number {
    return this.bytes;
  }
}
