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

/**
 * Compose the `stdio` array for {@link spawn} based on whether the
 * caller requested an interactive stdin and whether the parent has
 * one to give. Falls back to `"ignore"` whenever the parent is not
 * connected to a TTY (CI runs, piped invocations, tests) so a missing
 * controlling terminal can never wedge the child waiting on input.
 */
export function chooseStdio(
  command: string,
  preference: boolean | "auto" | undefined,
): ["ignore" | "inherit", "pipe", "pipe"] {
  // Hard ban: TUI and other hosts that cannot survive stdin takeover.
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

/**
 * Capture stdin's current `isRaw` state and switch it to cooked mode so
 * an interactive child (sudo, ssh) can read a password line through the
 * inherited stdin. Returns an idempotent restore used from every exit path.
 */
export function takeOverCookedStdin(): () => void {
  if (!process.stdin.isTTY) return () => {};
  const stream = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const wasRaw = Boolean(stream.isRaw);
  try {
    if (wasRaw) stream.setRawMode(false);
    process.stdin.pause();
  } catch {
    /* ignore */
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
      /* ignore */
    }
    try {
      process.stdin.resume();
    } catch {
      /* ignore */
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
    // Command transcripts routinely contain tokens, target data, and env
    // dumps — never leave them world-readable on a multi-user box.
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    return { path, stream };
  } catch {
    return undefined;
  }
}

/**
 * Streaming UTF-8 decoder with byte accounting and a binary sniff.
 *
 * `chunk.toString()` per chunk splits multi-byte characters at buffer
 * boundaries (mojibake in nmap banners, i18n build logs, unicode filenames),
 * and `text.length` counts UTF-16 code units, so every byte cap was wrong for
 * non-ASCII output. Binary output is detected once and reported so the model
 * gets a marker instead of lossy text.
 * Exported only for tests.
 */
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

/** A small ring buffer of recent output lines used as the "tail" summary.
 *  Exported only for tests. */ export class RingBuffer {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly capacity: number) {}

  push(text: string): void {
    // When a single chunk is larger than our capacity, keep only its
    // tail. Otherwise some platforms (notably Windows, where Node delivers
    // stdout in one big buffer) leave the ring holding far more than
    // capacity bytes and the model-facing summary blows past maxModelBytes.
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
    // After shifting all but one chunk we may still be over capacity if
    // the remaining chunk is itself larger than the cap. Trim it down.
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
