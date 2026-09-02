/**
 * Bounded, owner-private artifact capture for one interactive session.
 *
 * The writer only ever receives canonical redacted bytes, so nothing sensitive
 * becomes durable. Chunk names contain only the opaque session id and an index —
 * never a command, cwd, or timestamp that could identify the workload.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import { join } from "node:path";
import { getArtifactDir } from "../store/paths.js";
import type { OutputSink } from "./output-store.js";
import type { ArtifactReceipt, ArtifactReference } from "./types.js";

export interface ArtifactWriterOptions {
  readonly sessionId: string;
  readonly directory: string;
  readonly captureBytes: number;
  readonly chunkBytes: number;
  readonly persistenceQueueBytes: number;
  readonly onLimit: "terminate" | "continue";
}

export class BoundedArtifactWriter implements OutputSink {
  private stream: WriteStream | undefined;
  private streamDone: Promise<void> | undefined;
  private readonly completedStreams: Promise<void>[] = [];
  private readonly chunks: string[] = [];
  private hash: Hash = createHash("sha256");
  private index = 0;
  private currentChunkBytes = 0;
  private capturedBytes = 0;
  private dropped = 0;
  private pendingBytes = 0;
  private digest = "";
  private closePromise: Promise<void> | undefined;
  private writeError: Error | undefined;
  private readonly backpressured = new Set<WriteStream>();

  limitReached = false;
  failed = false;

  constructor(private readonly options: ArtifactWriterOptions) {}

  get path(): string {
    return join(this.options.directory, `${this.options.sessionId}.log`);
  }

  reference(): ArtifactReference {
    return {
      path: this.path,
      bytes: this.capturedBytes,
      droppedBytes: this.dropped,
      redacted: true,
    };
  }

  receipt(): ArtifactReceipt {
    return {
      ...this.reference(),
      chunks: [...this.chunks],
      sha256: this.digest,
    };
  }

  append(bytes: Uint8Array): boolean {
    if (this.failed || this.closePromise) return true;
    let data = bytes;
    const remaining = Math.max(0, this.options.captureBytes - this.capturedBytes);
    if (data.length > remaining) {
      this.dropped += data.length - remaining;
      data = data.subarray(0, remaining);
      this.limitReached = this.options.onLimit === "terminate";
    }
    let writable = true;
    while (data.length > 0) {
      if (!this.stream || this.currentChunkBytes >= this.options.chunkBytes) {
        this.rotate();
      }
      const room = this.options.chunkBytes - this.currentChunkBytes;
      const part = data.subarray(0, room);
      const stream = this.stream!;
      const accepted = stream.write(Buffer.from(part));
      if (!accepted) {
        this.backpressured.add(stream);
        this.pendingBytes += part.length;
      }
      writable = accepted && writable;
      this.hash.update(part);
      this.digest = this.hash.copy().digest("hex");
      this.capturedBytes += part.length;
      this.currentChunkBytes += part.length;
      data = data.subarray(part.length);
    }
    if (this.writeError) this.failed = true;
    if (this.pendingBytes > this.options.persistenceQueueBytes) this.failed = true;
    return writable;
  }

  async waitForDrain(): Promise<void> {
    const blocked = [...this.backpressured].filter((stream) => stream.writableNeedDrain);
    if (blocked.length === 0) {
      this.pendingBytes = 0;
      return;
    }
    await Promise.all(
      blocked.map(
        (stream) =>
          new Promise<void>((resolve) => {
            const done = (): void => {
              stream.off("drain", done);
              stream.off("finish", done);
              stream.off("error", done);
              this.backpressured.delete(stream);
              resolve();
            };
            stream.once("drain", done);
            stream.once("finish", done);
            stream.once("error", done);
          }),
      ),
    );
    this.pendingBytes = 0;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.finishCurrentStream();
    this.closePromise = Promise.all(this.completedStreams).then(() => {
      if (this.writeError) {
        this.failed = true;
        throw this.writeError;
      }
    });
    return this.closePromise;
  }

  private finishCurrentStream(): void {
    if (!this.stream || !this.streamDone) return;
    const stream = this.stream;
    const done = this.streamDone;
    this.stream = undefined;
    this.streamDone = undefined;
    stream.end();
    this.completedStreams.push(done);
  }

  private rotate(): void {
    this.finishCurrentStream();
    const path = this.index === 0 ? this.path : `${this.path}.${this.index}`;
    this.index += 1;
    this.currentChunkBytes = 0;
    this.chunks.push(path);
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    this.stream = stream;
    this.streamDone = new Promise<void>((resolve) => {
      stream.once("finish", resolve);
      stream.once("error", (error) => {
        this.writeError ??= error;
        this.failed = true;
        resolve();
      });
    });
  }
}

export async function createArtifactWriter(options: {
  sessionId: string;
  captureBytes: number;
  chunkBytes: number;
  persistenceQueueBytes: number;
  onLimit: "terminate" | "continue";
  baseDir?: string | undefined;
}): Promise<BoundedArtifactWriter> {
  const directory = join(
    options.baseDir ?? getArtifactDir(),
    `interactive-${options.sessionId}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return new BoundedArtifactWriter({
    sessionId: options.sessionId,
    directory,
    captureBytes: options.captureBytes,
    chunkBytes: options.chunkBytes,
    persistenceQueueBytes: options.persistenceQueueBytes,
    onLimit: options.onLimit,
  });
}
