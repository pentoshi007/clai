import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolResult, ToolStats } from "../types.js";
import { redactSecrets } from "../llm/provider.js";

export interface ShellExecArgs {
  command: string;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  /** Max bytes of output to retain in memory for the model (head+tail). */
  maxModelBytes?: number | undefined;
  /** Max bytes streamed to the artifact file before the child is terminated. */
  maxCaptureBytes?: number | undefined;
  /** Behavior when maxCaptureBytes is exceeded. Defaults to "terminate". */
  onLimit?: "terminate" | "continue" | undefined;
  /** Where to save the raw artifact. When undefined, ~/.clai/outputs is used. */
  artifactPath?: string | undefined;
  /** When true, do not allocate an artifact file (used by tests / dry runs). */
  noArtifact?: boolean | undefined;
}

export interface SpawnArgvArgs {
  command: string;
  argv: string[];
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  maxModelBytes?: number | undefined;
  maxCaptureBytes?: number | undefined;
  onLimit?: "terminate" | "continue" | undefined;
  artifactPath?: string | undefined;
  noArtifact?: boolean | undefined;
}

const DEFAULT_MAX_MODEL_BYTES = 12_000;
const DEFAULT_MAX_CAPTURE_BYTES = 500 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

function safeArtifactName(command: string): string {
  const head = command.trim().split(/\s+/)[0] ?? "shell";
  const clean = head.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "");
  return clean || "shell";
}

async function openArtifact(
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
    const dir = override
      ? join(override, "..")
      : join(homedir(), ".clai", "outputs");
    await mkdir(dir, { recursive: true });
    const path =
      override ??
      join(
        dir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeArtifactName(command)}.txt`,
      );
    const stream = createWriteStream(path, { flags: "w" });
    return { path, stream };
  } catch {
    return undefined;
  }
}

/** A small ring buffer of recent output lines used as the "tail" summary.
 *  Exported only for tests. */
export class RingBuffer {
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

/**
 * Re-read a freshly written artifact, run it through the same redactor
 * the model-facing output uses, and write it back atomically. This is a
 * defense-in-depth measure: live capture is unavoidable byte-by-byte, so
 * we redact post-hoc the moment the child closes, before any reader
 * (user, model, or `/output last`) gets a chance to see the raw bytes.
 *
 * Returns whether the artifact was rewritten. Any error is swallowed — a
 * raw artifact is still better than an inaccessible one, and the model
 * never receives the unredacted content (that path runs through
 * redactSecrets() too).
 */
async function redactArtifactInPlace(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    const redacted = redactSecrets(raw);
    if (redacted === raw) return false;
    await writeFile(path, redacted, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export async function shellExec(args: ShellExecArgs): Promise<ToolResult> {
  if (args.signal?.aborted) {
    return { ok: false, output: "Command aborted.", exitCode: 130 };
  }

  const maxModelBytes = args.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES;
  const maxCaptureBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const onLimit = args.onLimit ?? "continue";
  const halfModel = Math.max(512, Math.floor(maxModelBytes / 2));

  const start = Date.now();
  const artifact = args.noArtifact
    ? undefined
    : await openArtifact(args.command, args.artifactPath);

  let head = "";
  const tail = new RingBuffer(halfModel);
  let bytesRead = 0;
  let bytesDropped = 0;
  let linesRead = 0;
  let captureLimitHit = false;

  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(args.command, {
      cwd: args.cwd ?? process.cwd(),
      detached,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let aborted = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      args.signal?.removeEventListener("abort", abort);
      if (artifact) {
        artifact.stream.end();
      }
    };

    const append = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const text = chunk.toString();
      bytesRead += text.length;
      linesRead += text.split("\n").length - 1;
      // Stream raw bytes to the artifact file (cheap; no concat).
      if (artifact && !captureLimitHit) {
        if (bytesRead <= maxCaptureBytes) {
          artifact.stream.write(text);
        } else {
          // Write only the prefix that fits under the cap, then close.
          const overflow = bytesRead - maxCaptureBytes;
          const allowed = text.length - overflow;
          if (allowed > 0) artifact.stream.write(text.slice(0, allowed));
          captureLimitHit = true;
          artifact.stream.end();
        }
      }
      // Maintain head + ring-tail model summary.
      if (head.length < halfModel) {
        const room = halfModel - head.length;
        head += text.slice(0, room);
        if (text.length > room) tail.push(text.slice(room));
      } else {
        tail.push(text);
      }
      // Track bytes we dropped from the in-memory ring buffer for stats.
      const inMemory = head.length + tail.size();
      bytesDropped = Math.max(0, bytesRead - inMemory);
      // Live preview is still sent through onOutput so the UI can dim it.
      args.onOutput?.(text, stream);
      // Optional capture-limit termination.
      if (captureLimitHit && onLimit === "terminate") {
        terminate("cap");
      }
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Process may have already exited.
      }
    };

    const terminate = (reason: "abort" | "timeout" | "cap"): void => {
      if (reason === "abort") aborted = true;
      if (reason === "timeout") timedOut = true;
      killChild("SIGTERM");
      forceKill = setTimeout(() => killChild("SIGKILL"), 1_000);
    };

    const abort = (): void => terminate("abort");

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error) => {
      cleanup();
      if (aborted || args.signal?.aborted) {
        resolve({ ok: false, output: "Command aborted.", exitCode: 130 });
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      cleanup();
      const stats: ToolStats = {
        bytesRead,
        bytesDropped,
        linesRead,
        elapsedMs: Date.now() - start,
        captureLimitHit,
      };

      const trimmedTail = tail.toString().trim();
      const trimmedHead = head.trim();
      const inMemory = head.length + tail.size();
      let combined: string;
      if (bytesRead === 0) {
        combined = "";
      } else if (inMemory >= bytesRead) {
        // Everything fit in memory; concat head+tail back into one string.
        combined = (head + tail.toString()).trimEnd();
      } else {
        const omittedBytes = bytesRead - inMemory;
        combined =
          `${trimmedHead}\n... (${omittedBytes.toLocaleString()} bytes / ~${linesRead.toLocaleString()} lines truncated — full output in artifact) ...\n${trimmedTail}`.trim();
      }

      // Always redact before exposing the bounded text to callers.
      const output = redactSecrets(combined);

      // Redact the on-disk artifact too so `/output last` and any later
      // reader (model, user, audit) sees the same scrubbed bytes.
      const finalize = (result: ToolResult): void => {
        if (artifact) {
          // Wait for the artifact write stream to flush, then redact in
          // place, then resolve. Awaiting matters: tests and downstream
          // readers must never see the unredacted bytes, even briefly.
          const onFlushed = (): void => {
            void redactArtifactInPlace(artifact.path).then(() =>
              resolve(result),
            );
          };
          if ((artifact.stream as WriteStream).writableFinished) {
            onFlushed();
          } else {
            artifact.stream.once("finish", onFlushed);
            artifact.stream.once("error", onFlushed);
          }
        } else {
          resolve(result);
        }
      };

      if (aborted || args.signal?.aborted) {
        finalize({
          ok: false,
          output: output ? `${output}\nCommand aborted.` : "Command aborted.",
          exitCode: 130,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (timedOut) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand timed out.`
            : "Command timed out.",
          exitCode: 124,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (captureLimitHit) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand killed after exceeding capture cap of ${maxCaptureBytes.toLocaleString()} bytes.`
            : "Command exceeded capture cap.",
          exitCode: 137,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: true,
          stats,
        });
        return;
      }
      finalize({
        ok: code === 0,
        output,
        exitCode: code ?? undefined,
        ...(artifact ? { outputPath: artifact.path } : {}),
        truncated: bytesRead > inMemory,
        stats,
      });
    });

    args.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(
      () => terminate("timeout"),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
}

/**
 * Run a child process with `shell: false`, passing argv directly. Use this
 * for any tool that builds command lines from model-provided strings (eg
 * `net.scan`, `pentest.recon`, `pkg.install`). Sharing argv with the OS
 * shell would let a malicious target turn into "; rm -rf /" — `shell: false`
 * + argv prevents that even if the model is adversarial.
 *
 * The capture pipeline (head + ring-tail + artifact + cap-and-kill + stats)
 * is identical to shellExec.
 */
export async function spawnArgv(args: SpawnArgvArgs): Promise<ToolResult> {
  if (args.signal?.aborted) {
    return { ok: false, output: "Command aborted.", exitCode: 130 };
  }

  const maxModelBytes = args.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES;
  const maxCaptureBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const onLimit = args.onLimit ?? "continue";
  const halfModel = Math.max(512, Math.floor(maxModelBytes / 2));

  const display = `${args.command} ${args.argv.join(" ")}`.trim();
  const start = Date.now();
  const artifact = args.noArtifact
    ? undefined
    : await openArtifact(args.command, args.artifactPath);

  let head = "";
  const tail = new RingBuffer(halfModel);
  let bytesRead = 0;
  let bytesDropped = 0;
  let linesRead = 0;
  let captureLimitHit = false;

  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(args.command, args.argv, {
      cwd: args.cwd ?? process.cwd(),
      detached,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let aborted = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      args.signal?.removeEventListener("abort", abort);
      if (artifact) artifact.stream.end();
    };

    const append = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const text = chunk.toString();
      bytesRead += text.length;
      linesRead += text.split("\n").length - 1;
      if (artifact && !captureLimitHit) {
        if (bytesRead <= maxCaptureBytes) {
          artifact.stream.write(text);
        } else {
          const overflow = bytesRead - maxCaptureBytes;
          const allowed = text.length - overflow;
          if (allowed > 0) artifact.stream.write(text.slice(0, allowed));
          captureLimitHit = true;
          artifact.stream.end();
        }
      }
      if (head.length < halfModel) {
        const room = halfModel - head.length;
        head += text.slice(0, room);
        if (text.length > room) tail.push(text.slice(room));
      } else {
        tail.push(text);
      }
      const inMemory = head.length + tail.size();
      bytesDropped = Math.max(0, bytesRead - inMemory);
      args.onOutput?.(text, stream);
      if (captureLimitHit && onLimit === "terminate") terminate("cap");
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already exited
      }
    };

    const terminate = (reason: "abort" | "timeout" | "cap"): void => {
      if (reason === "abort") aborted = true;
      if (reason === "timeout") timedOut = true;
      killChild("SIGTERM");
      forceKill = setTimeout(() => killChild("SIGKILL"), 1_000);
    };

    const abort = (): void => terminate("abort");

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error) => {
      cleanup();
      if (aborted || args.signal?.aborted) {
        resolve({ ok: false, output: "Command aborted.", exitCode: 130 });
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      cleanup();
      const stats: ToolStats = {
        bytesRead,
        bytesDropped,
        linesRead,
        elapsedMs: Date.now() - start,
        captureLimitHit,
      };
      const trimmedTail = tail.toString().trim();
      const trimmedHead = head.trim();
      const inMemory = head.length + tail.size();
      let combined: string;
      if (bytesRead === 0) {
        combined = "";
      } else if (inMemory >= bytesRead) {
        combined = (head + tail.toString()).trimEnd();
      } else {
        const omittedBytes = bytesRead - inMemory;
        combined =
          `${trimmedHead}\n... (${omittedBytes.toLocaleString()} bytes / ~${linesRead.toLocaleString()} lines truncated — full output in artifact) ...\n${trimmedTail}`.trim();
      }
      const output = redactSecrets(`$ ${display}\n${combined}`.trimEnd());
      const finalize = (result: ToolResult): void => {
        if (artifact) {
          const onFlushed = (): void => {
            void redactArtifactInPlace(artifact.path).then(() =>
              resolve(result),
            );
          };
          if ((artifact.stream as WriteStream).writableFinished) {
            onFlushed();
          } else {
            artifact.stream.once("finish", onFlushed);
            artifact.stream.once("error", onFlushed);
          }
        } else {
          resolve(result);
        }
      };
      if (aborted || args.signal?.aborted) {
        finalize({
          ok: false,
          output: output ? `${output}\nCommand aborted.` : "Command aborted.",
          exitCode: 130,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (timedOut) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand timed out.`
            : "Command timed out.",
          exitCode: 124,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (captureLimitHit) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand killed after exceeding capture cap of ${maxCaptureBytes.toLocaleString()} bytes.`
            : "Command exceeded capture cap.",
          exitCode: 137,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: true,
          stats,
        });
        return;
      }
      finalize({
        ok: code === 0,
        output,
        exitCode: code ?? undefined,
        ...(artifact ? { outputPath: artifact.path } : {}),
        truncated: bytesRead > inMemory,
        stats,
      });
    });

    args.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(
      () => terminate("timeout"),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
}
